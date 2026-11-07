import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrCompanyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import { PAYMENT_NOTICES, sendPaymentEmails } from '@/lib/email/paymentEmails'
import type { PaymentEmailKind } from '@/lib/email/templates'
import { isValidPrice } from '@/lib/money'
import {
  datesProblem,
  INVOICE_NUMBER_MAX,
  PAYMENT_NOTES_MAX,
  type PaymentError,
} from '@/lib/payments/fields'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'

type Rel = number | { id: number } | null | undefined

/** Context keys the server sets. A client cannot set `req.context` through any API. */
export type PaymentContext = {
  /**
   * The row's `updatedAt` when the team member's form loaded. The save is refused when the row
   * changed since, so one member's save never silently undoes another's (savePayment).
   */
  paymentVersion?: string
  /**
   * The notices a save makes due (a date recorded on a row that had none), by match id. Set by the
   * beforeChange hook from the row read under its lock, sent by the afterChange hook, once.
   */
  paymentNotices?: Record<number, PaymentEmailKind[]>
  /**
   * Set by the Projects hook when a new price follows onto the row. Checked again under the lock:
   * an invoice sent meanwhile keeps the price it was sent with.
   */
  feeFollowsProject?: boolean
}

/** An APIError with a code the team's screen maps to its own message. */
const fail = (code: PaymentError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * The manual payment log (lib/payments/fields.ts): one row per paid match, made by the server when
 * Konnected selects a student for a paid project (Matches hook). Version 1 has no payment
 * provider; the team records the dates by hand.
 *
 * Admin reads and writes everything. A company reads a summary of its own invoices: the price
 * (excluding VAT), the invoice number and when the invoice was sent and paid. A student reads only
 * whether and when they were paid. What the student is paid, Konnected's share and the team's
 * notes are admin-only. Nobody but admins writes.
 */
export const Payments: CollectionConfig = {
  slug: 'payments',
  admin: { defaultColumns: ['match', 'projectFee', 'invoiceSentAt', 'invoicePaidAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'match.student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId ? { 'match.project.company': { equals: companyId } } : false
    },
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc: loaded, operation, req, context }) => {
        let originalDoc = loaded
        const matchId = relationId((data.match ?? originalDoc?.match) as Rel)
        if (!matchId) throw fail('not_found', 'A payment needs a match', 400)
        if (operation === 'update' && matchId !== relationId(originalDoc?.match as Rel)) {
          throw new APIError('A payment keeps its match', 400)
        }

        if (operation === 'update') {
          // Two saves of one row run one after the other. Each reads the row again after the lock,
          // so the date checks below see what the other one saved.
          const id = originalDoc!.id as number
          await lockRow(req, 'payments', id)
          const fresh = await req.payload.findByID({
            collection: 'payments',
            id,
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (!fresh) throw fail('not_found', 'The payment does not exist', 404)
          const expected = (context as PaymentContext | undefined)?.paymentVersion
          if (expected !== undefined && fresh.updatedAt !== expected) {
            throw fail('not_open', 'Someone saved this row meanwhile. Load it again.', 409)
          }
          originalDoc = fresh
          if ((context as PaymentContext | undefined)?.feeFollowsProject && fresh.invoiceSentAt) {
            delete data.projectFee
          }
        }

        if (operation === 'create') {
          // Bypass: the server reads the match's project to apply the paid-or-unpaid rule.
          const match = await req.payload.findByID({
            collection: 'matches',
            id: matchId,
            depth: 0,
            select: { project: true },
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          const projectId = relationId(match?.project as Rel)
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: projectId,
                depth: 0,
                select: { paidOrUnpaid: true, fee: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!project) throw fail('not_found', 'The match has no project', 404)
          // An unpaid project has no payment rows (owner decision 2026-11-05).
          if (project.paidOrUnpaid !== 'paid') {
            throw fail('unpaid', 'An unpaid project has no payments', 400)
          }
          // The fixed price Konnected set at review, unless the team typed one.
          if (data.projectFee === undefined || data.projectFee === null) {
            data.projectFee = isValidPrice(project.fee) ? project.fee : null
          }
        }
        if (
          data.projectFee !== undefined &&
          data.projectFee !== null &&
          !isValidPrice(data.projectFee)
        ) {
          throw new APIError('The price must be a whole amount', 400)
        }

        if (data.invoiceNumber !== undefined) {
          data.invoiceNumber = text(data.invoiceNumber)
          if ((data.invoiceNumber?.length ?? 0) > INVOICE_NUMBER_MAX)
            throw fail('too_long', 'The invoice number is too long')
        }
        if (data.notes !== undefined) {
          data.notes = text(data.notes)
          if ((data.notes?.length ?? 0) > PAYMENT_NOTES_MAX)
            throw fail('too_long', 'The notes are too long')
        }

        // The dates in order, none ahead of today, checked on the row as it will be saved.
        const pick = (key: 'invoiceSentAt' | 'invoicePaidAt' | 'studentPaidAt') =>
          storedToDay(key in data ? data[key] : originalDoc?.[key])
        const problem = datesProblem(
          {
            invoiceSent: pick('invoiceSentAt'),
            invoicePaid: pick('invoicePaidAt'),
            studentPaid: pick('studentPaidAt'),
          },
          todayInOslo(),
        )
        if (problem) throw fail(problem, `The payment dates are not possible (${problem})`)

        // Payment notices (lib/email/paymentEmails.ts): a date recorded on a row that had none.
        // Compared with the row as read under the lock, so two saves at once, or saving the row
        // again, never send a notice twice. Changing a recorded date sends nothing.
        const due: PaymentEmailKind[] = []
        for (const { field, kind } of PAYMENT_NOTICES) {
          if (storedToDay(originalDoc?.[field]) || !pick(field)) continue
          // A date cleared and recorded again is not a new transition: the activity log shows
          // whether this row had the date before (Payments log every date change).
          if (operation === 'update') {
            const before = await req.payload.count({
              collection: 'activity-logs',
              where: {
                and: [
                  { targetCollection: { equals: 'payments' } },
                  { targetId: { equals: String(originalDoc!.id) } },
                  { field: { equals: field } },
                  { toStatus: { exists: true } },
                  { toStatus: { not_equals: '' } },
                ],
              },
              overrideAccess: true,
              req,
            })
            if (before.totalDocs > 0) continue
          }
          due.push(kind)
        }
        const ctx = req.context as PaymentContext
        ctx.paymentNotices = { ...(ctx.paymentNotices ?? {}), [matchId]: due }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({
        alsoLog: ['invoiceSentAt', 'invoicePaidAt', 'studentPaidAt', 'projectFee', 'invoiceNumber'],
      }),
      async ({ doc, req }) => {
        const ctx = req.context as PaymentContext
        const matchId = relationId(doc.match as Rel)
        const due = matchId ? ctx.paymentNotices?.[matchId] : undefined
        if (!matchId || !due?.length) return doc
        delete ctx.paymentNotices![matchId]
        await sendPaymentEmails(req, doc, due)
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  indexes: [{ fields: ['match'], unique: true }],
  fields: [
    {
      name: 'match',
      type: 'relationship',
      relationTo: 'matches',
      required: true,
      index: true,
    },
    {
      // The fixed price excluding VAT, copied from the project when the row is made. 25 % VAT and
      // the total are worked out from it (lib/money.ts), not stored.
      name: 'projectFee',
      label: 'Price (NOK, excl. VAT)',
      type: 'number',
      min: 0,
      access: { read: adminOrCompanyField },
    },
    { name: 'konnectedShare', type: 'number', min: 0, access: { read: adminOnlyField } },
    { name: 'studentPay', type: 'number', min: 0, access: { read: adminOnlyField } },
    {
      name: 'invoiceNumber',
      type: 'text',
      maxLength: INVOICE_NUMBER_MAX,
      access: { read: adminOrCompanyField },
    },
    { name: 'invoiceSentAt', type: 'date', access: { read: adminOrCompanyField } },
    { name: 'invoicePaidAt', type: 'date', access: { read: adminOrCompanyField } },
    {
      // Paid in the monthly pay run, only after the company paid. The student sees this date.
      name: 'studentPaidAt',
      type: 'date',
      access: { read: adminOrStudentField },
    },
    {
      // The team's own notes. Never shown to the company or the student.
      name: 'notes',
      type: 'textarea',
      maxLength: PAYMENT_NOTES_MAX,
      access: { read: adminOnlyField },
    },
  ],
}
