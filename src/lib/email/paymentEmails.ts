import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { dueDay, rowAmounts } from '@/lib/payments/fields'
import { storedToDay } from '@/lib/projects/fields'
import type { Payment } from '@/payload-types'

import { studentRecipient } from './matchingEmails'
import { companyRecipient } from './projectEmails'
import { type EmailType, sendEmail } from './send'
import { paymentEmail, type PaymentEmailKind } from './templates'

type Rel = number | { id: number } | null | undefined

/** The payment log's dates that send a notice, the first time each is recorded on a row. */
export const PAYMENT_NOTICES: readonly {
  field: 'invoiceSentAt' | 'invoicePaidAt' | 'studentPaidAt'
  kind: PaymentEmailKind
}[] = [
  { field: 'invoiceSentAt', kind: 'invoiceSent' },
  { field: 'invoicePaidAt', kind: 'invoicePaid' },
  { field: 'studentPaidAt', kind: 'studentPaid' },
]

const TYPE: Record<PaymentEmailKind, EmailType> = {
  invoiceSent: 'invoice_sent',
  invoicePaid: 'invoice_paid',
  studentPaid: 'student_paid',
}

/**
 * The payment notices of the manual payment log, each in the recipient's saved language, sent
 * after the response: to the company when the team records that the invoice was sent and that the
 * company paid (with the price, VAT and total from the row), and to the student when the team
 * records the pay run (with what the student is paid, when Konnected set it on the project; the
 * student already reads that amount there).
 *
 * The Payments hook decides which notices are due (a date recorded on a row that had none,
 * compared with the row read under its lock), so saving the row again never sends one twice.
 *
 * Minimal personal data: the project title and the amounts only; no invoice number, no notes, no
 * student in the company's emails, no company price in the student's. Bypass: the server reads
 * the match, the project and the recipients' addresses with `overrideAccess: true`. Only the email
 * type and the user id are logged.
 */
export async function sendPaymentEmails(
  req: PayloadRequest,
  payment: Pick<Payment, 'match' | 'projectFee' | 'invoiceSentAt'>,
  kinds: readonly PaymentEmailKind[],
): Promise<void> {
  const matchId = relationId(payment.match as Rel)
  if (!matchId || !kinds.length) return
  const match = await req.payload.findByID({
    collection: 'matches',
    id: matchId,
    depth: 0,
    select: { project: true, student: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const projectId = relationId(match?.project as Rel)
  if (!match || !projectId) return
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, company: true, studentPay: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project) return

  for (const kind of kinds) {
    if (kind === 'studentPaid') {
      const to = await studentRecipient(req, relationId(match.student as Rel))
      if (!to) continue
      await sendEmail(req.payload, {
        to: to.email,
        email: paymentEmail(to.locale, kind, {
          title: project.title,
          amount: project.studentPay ?? null,
          href: `${appUrl()}/${to.locale}/student/payments`,
        }),
        type: TYPE[kind],
        userId: to.id,
      })
      continue
    }
    const to = await companyRecipient(req, relationId(project.company as Rel))
    if (!to) continue
    await sendEmail(req.payload, {
      to: to.email,
      email: paymentEmail(to.locale, kind, {
        title: project.title,
        price: rowAmounts(payment.projectFee),
        dueDay: kind === 'invoiceSent' ? dueDay(storedToDay(payment.invoiceSentAt)) : null,
        href: `${appUrl()}/${to.locale}/company/payments`,
      }),
      type: TYPE[kind],
      userId: to.id,
    })
  }
}
