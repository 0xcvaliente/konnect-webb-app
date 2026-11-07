import type { Payload } from 'payload'

import { isCompany, isStudent, relationId } from '@/access/roles'
import type { PriceBreakdown } from '@/lib/money'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/students/profile'
import type { Payment } from '@/payload-types'

import {
  type CompanyInvoiceStatus,
  companyInvoiceStatus,
  dueDay,
  rowAmounts,
  type StudentPayoutStatus,
  studentPayoutStatus,
} from './fields'

/**
 * What the company and the student see of the payment log. Read as the signed-in user with access
 * control on: the Payments collection gives a company only its own rows and only the invoice
 * fields, and a student only their own rows and only the date they were paid. Nothing here reads
 * the team's notes, Konnected's share or what the student is paid.
 */

const asUser = (user: SessionUser) => ({ user, overrideAccess: false as const })

export type CompanyInvoice = {
  id: number
  projectId: number
  title: string
  invoiceNumber: string | null
  amounts: PriceBreakdown | null
  /** `YYYY-MM-DD` in Oslo, or null. */
  sent: string | null
  paid: string | null
  due: string | null
  status: CompanyInvoiceStatus
}

/** The company's own invoices, one per paid project with a selected student. */
export async function listCompanyInvoices(
  payload: Payload,
  user: SessionUser | null,
): Promise<CompanyInvoice[] | null> {
  if (!user || !isCompany(user)) return null
  const payments = await payload.find({
    collection: 'payments',
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    ...asUser(user),
  })
  if (!payments.docs.length) return []
  const matchIds = [...new Set(payments.docs.map((p) => relationId(p.match as number)!))]
  const matches = await payload.find({
    collection: 'matches',
    where: { id: { in: matchIds } },
    depth: 0,
    pagination: false,
    select: { project: true },
    ...asUser(user),
  })
  const projectIds = [...new Set(matches.docs.map((m) => relationId(m.project as number)!))]
  const projects = await payload.find({
    collection: 'projects',
    where: { id: { in: projectIds } },
    depth: 0,
    pagination: false,
    select: { title: true },
    ...asUser(user),
  })
  const projectOfMatch = new Map(matches.docs.map((m) => [m.id, relationId(m.project as number)!]))
  const titleOf = new Map(projects.docs.map((p) => [p.id, p.title]))
  const today = todayInOslo()
  return (payments.docs as Payment[]).flatMap((p) => {
    const projectId = projectOfMatch.get(relationId(p.match as number)!)
    if (!projectId || !titleOf.has(projectId)) return []
    const days = {
      invoiceSent: storedToDay(p.invoiceSentAt),
      invoicePaid: storedToDay(p.invoicePaidAt),
    }
    return [
      {
        id: p.id,
        projectId,
        title: titleOf.get(projectId)!,
        invoiceNumber: p.invoiceNumber ?? null,
        amounts: rowAmounts(p.projectFee),
        sent: days.invoiceSent,
        paid: days.invoicePaid,
        due: dueDay(days.invoiceSent),
        status: companyInvoiceStatus(days, today),
      },
    ]
  })
}

export type StudentPayment = {
  id: number
  title: string
  companyName: string | null
  /** Where the student's pay stands: waiting for the company, in the next pay run, or paid. */
  status: StudentPayoutStatus
  /** The day Konnected paid the student (`YYYY-MM-DD`, Oslo), or null while not paid. */
  paidOn: string | null
  /** What the student is paid for the project (NOK), if the team set it. */
  pay: number | null
  /** The student's application for the project, for the link. */
  applicationId: number | null
}

/**
 * The student's own payments, status only: waiting for the company to pay Konnected, in the next
 * monthly pay run (the company paid), or paid on a day. The only amount is the student's own pay,
 * if the team set it; nothing about the company's invoice, its dates or the price.
 */
export async function listStudentPayments(
  payload: Payload,
  user: SessionUser | null,
): Promise<StudentPayment[] | null> {
  if (!user || !isStudent(user)) return null
  const payments = await payload.find({
    collection: 'payments',
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    ...asUser(user),
  })
  if (!payments.docs.length) return []
  const matchIds = [...new Set(payments.docs.map((p) => relationId(p.match as number)!))]
  const matches = await payload.find({
    collection: 'matches',
    where: { id: { in: matchIds } },
    depth: 0,
    pagination: false,
    select: { project: true, endedAt: true },
    ...asUser(user),
  })
  // A match Konnected ended is shown only once the student was paid for it (case by case).
  const ended = new Set(matches.docs.filter((m) => m.endedAt).map((m) => m.id))
  // A student no longer reads a matched project; the title and company are the copies kept on the
  // student's own application.
  const projectIds = [...new Set(matches.docs.map((m) => relationId(m.project as number)!))]
  const applications = await payload.find({
    collection: 'applications',
    where: { project: { in: projectIds } },
    depth: 0,
    pagination: false,
    select: { project: true, projectTitle: true, companyName: true },
    ...asUser(user),
  })
  const projectOfMatch = new Map(matches.docs.map((m) => [m.id, relationId(m.project as number)!]))
  const applicationOf = new Map(applications.docs.map((a) => [relationId(a.project as number)!, a]))
  return (payments.docs as Payment[])
    .filter((p) => p.studentPaidAt || !ended.has(relationId(p.match as number)!))
    .map((p) => {
      const application = applicationOf.get(projectOfMatch.get(relationId(p.match as number)!) ?? 0)
      const paidOn = storedToDay(p.studentPaidAt)
      return {
        id: p.id,
        title: application?.projectTitle ?? '',
        companyName: application?.companyName ?? null,
        // Stored by the Payments hook from the dates (the student cannot read the company's).
        status: (p.studentPayout ??
          studentPayoutStatus({ invoicePaid: null, studentPaid: paidOn })) as StudentPayoutStatus,
        paidOn,
        pay: typeof p.studentPay === 'number' ? p.studentPay : null,
        applicationId: application?.id ?? null,
      }
    })
}
