import type { Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import type { PriceBreakdown } from '@/lib/money'
import {
  ACTION_STATUSES,
  datesProblem,
  dueDay,
  INVOICE_NUMBER_MAX,
  PAYMENT_NOTES_MAX,
  PAYMENT_STATUSES,
  type PaymentError,
  paymentErrorCode,
  type PaymentFilter,
  type PaymentFormState,
  paymentStatus,
  type PaymentStatus,
  rowAmounts,
} from '@/lib/payments/fields'
import { dayToStored, parseDay, storedToDay, todayInOslo } from '@/lib/projects/fields'
import type { PaymentContext } from '@/collections/Payments'
import type { Company, Payment } from '@/payload-types'

import { type Owner, ownersById, type SessionUser } from './approvals'

/**
 * The team's payment log (Kanban card "Manual payment log in admin", mockup "Payments"): one row
 * per paid match with the price, 25 % VAT and the total, when the invoice was sent and paid, when
 * the student was paid, and the team's notes. Read and written through the Local API as the team
 * member with `overrideAccess: false`; the Payments hook checks the dates. Nothing here logs
 * notes or names.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

export type PaymentRow = {
  id: number
  matchId: number
  projectId: number
  title: string
  companyName: string | null
  studentName: string
  owner: Owner
  amounts: PriceBreakdown | null
  invoiceNumber: string | null
  /** `YYYY-MM-DD` in Oslo, or null. */
  invoiceSent: string | null
  invoicePaid: string | null
  studentPaid: string | null
  due: string | null
  /** When Konnected first released the work (ISO), or null. */
  releasedAt: string | null
  notes: string | null
  status: PaymentStatus
  /** The row's `updatedAt`: the form sends it back, so a save over someone else's is refused. */
  version: string
}

export type PaymentLog = {
  rows: PaymentRow[]
  /** Rows per status, over the whole log (before the filter). */
  counts: Record<PaymentStatus, number>
  /** Rows that need the team (to invoice, overdue, student to pay). */
  action: number
  total: number
}

/** Project statuses in which the work has been released to the company. */
const RELEASED_PROJECT = ['delivered', 'closed']

/** Every row of the log, newest match first, read as the team member. */
async function allRows(payload: Payload, actor: SessionUser): Promise<PaymentRow[]> {
  const payments = await payload.find({
    collection: 'payments',
    depth: 0,
    pagination: false,
    sort: '-createdAt',
    ...asActor(actor),
  })
  if (!payments.docs.length) return []
  const matchIds = [...new Set(payments.docs.map((p) => relationId(p.match as number)!))]
  const matches = await payload.find({
    collection: 'matches',
    where: { id: { in: matchIds } },
    depth: 0,
    pagination: false,
    select: { project: true, student: true },
    ...asActor(actor),
  })
  const projectIds = [...new Set(matches.docs.map((m) => relationId(m.project as number)!))]
  const studentIds = [...new Set(matches.docs.map((m) => relationId(m.student as number)!))]
  const [projects, profiles, released] = await Promise.all([
    payload.find({
      collection: 'projects',
      where: { id: { in: projectIds } },
      depth: 0,
      pagination: false,
      select: { title: true, companyName: true, company: true, status: true },
      ...asActor(actor),
    }),
    payload.find({
      collection: 'student-profiles',
      where: { id: { in: studentIds } },
      depth: 0,
      pagination: false,
      select: { name: true },
      ...asActor(actor),
    }),
    payload.find({
      collection: 'deliverables',
      where: { and: [{ match: { in: matchIds } }, { releasedAt: { exists: true } }] },
      depth: 0,
      pagination: false,
      select: { match: true, releasedAt: true },
      ...asActor(actor),
    }),
  ])
  const companyIds = [
    ...new Set(projects.docs.map((p) => relationId(p.company as number)).filter(Boolean)),
  ] as number[]
  const companies = companyIds.length
    ? await payload.find({
        collection: 'companies',
        where: { id: { in: companyIds } },
        depth: 0,
        pagination: false,
        select: { teamOwner: true },
        ...asActor(actor),
      })
    : { docs: [] as Pick<Company, 'id' | 'teamOwner'>[] }
  const ownerOf = new Map(companies.docs.map((c) => [c.id, relationId(c.teamOwner as number)]))
  const owners = await ownersById(payload, actor, [...ownerOf.values()])
  const matchOf = new Map(matches.docs.map((m) => [m.id, m]))
  const projectOf = new Map(projects.docs.map((p) => [p.id, p]))
  const nameOf = new Map(profiles.docs.map((p) => [p.id, p.name]))
  const firstRelease = new Map<number, string>()
  for (const d of released.docs) {
    const id = relationId(d.match as number)!
    const at = d.releasedAt!
    if (!firstRelease.has(id) || at < firstRelease.get(id)!) firstRelease.set(id, at)
  }
  const today = todayInOslo()

  const rows: PaymentRow[] = []
  for (const p of payments.docs as Payment[]) {
    const matchId = relationId(p.match as number)!
    const match = matchOf.get(matchId)
    const project = match ? projectOf.get(relationId(match.project as number)!) : undefined
    if (!match || !project) continue
    const days = {
      invoiceSent: storedToDay(p.invoiceSentAt),
      invoicePaid: storedToDay(p.invoicePaidAt),
      studentPaid: storedToDay(p.studentPaidAt),
    }
    const releasedAt = firstRelease.get(matchId) ?? null
    const isReleased = Boolean(releasedAt) || RELEASED_PROJECT.includes(project.status)
    rows.push({
      id: p.id,
      matchId,
      projectId: project.id,
      title: project.title,
      companyName: project.companyName ?? null,
      studentName: nameOf.get(relationId(match.student as number)!) ?? '',
      owner: owners.get(ownerOf.get(relationId(project.company as number) ?? 0) ?? 0) ?? null,
      amounts: rowAmounts(p.projectFee),
      invoiceNumber: p.invoiceNumber ?? null,
      ...days,
      due: dueDay(days.invoiceSent),
      releasedAt,
      notes: p.notes ?? null,
      status: paymentStatus(days, isReleased, today),
      version: p.updatedAt,
    })
  }
  return rows
}

/** The log, filtered. Null for anyone but the team. */
export async function listPaymentLog(
  payload: Payload,
  actor: SessionUser | null,
  { filter = 'action', mine = false }: { filter?: PaymentFilter; mine?: boolean } = {},
): Promise<PaymentLog | null> {
  if (!actor || !isAdmin(actor)) return null
  const all = (await allRows(payload, actor)).filter((r) => !mine || r.owner?.id === actor.id)
  const counts = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0])) as Record<
    PaymentStatus,
    number
  >
  for (const row of all) counts[row.status] += 1
  const action = all.filter((r) => ACTION_STATUSES.includes(r.status)).length
  const rows = all.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'action'
        ? ACTION_STATUSES.includes(r.status)
        : r.status === filter,
  )
  // What needs action first, then oldest first within a status.
  const order = (s: PaymentStatus) =>
    ACTION_STATUSES.includes(s) ? ACTION_STATUSES.indexOf(s) : 10 + PAYMENT_STATUSES.indexOf(s)
  rows.sort((a, b) => order(a.status) - order(b.status) || a.id - b.id)
  return { rows, counts, action, total: all.length }
}

/** Rows that need the team, for the menu. */
export async function paymentsCount(payload: Payload, actor: SessionUser | null): Promise<number> {
  return (await listPaymentLog(payload, actor))?.action ?? 0
}

const fail = (error: PaymentError): PaymentFormState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

/** A date field from the form: empty clears it, a `YYYY-MM-DD` day sets it, anything else fails. */
const dayField = (form: FormData, key: string): string | null | undefined => {
  const raw = form.get(key)
  if (typeof raw !== 'string' || !raw.trim()) return null
  return parseDay(raw.trim()) ?? undefined
}

/**
 * Save one row of the log as the team member: invoice number, the three dates and the notes. The
 * price comes from the project and is not edited here. The hook checks the dates again, and
 * refuses the save (`not_open`) when the row changed since the form loaded (`version`, the row's
 * `updatedAt`): the form writes every field, so a stale form would undo another member's save.
 */
export async function savePayment(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<PaymentFormState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const raw = form.get('id')
  const id = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
  if (!id) return fail('not_found')
  const versionRaw = form.get('version')
  const version = typeof versionRaw === 'string' ? versionRaw.trim() : ''
  const invoiceSent = dayField(form, 'invoiceSent')
  const invoicePaid = dayField(form, 'invoicePaid')
  const studentPaid = dayField(form, 'studentPaid')
  if (invoiceSent === undefined || invoicePaid === undefined || studentPaid === undefined)
    return fail('bad_date')
  const problem = datesProblem({ invoiceSent, invoicePaid, studentPaid }, todayInOslo())
  if (problem) return fail(problem)
  const numberRaw = form.get('invoiceNumber')
  const invoiceNumber = typeof numberRaw === 'string' ? numberRaw.trim() : ''
  const notesRaw = form.get('notes')
  const notes = typeof notesRaw === 'string' ? notesRaw.trim() : ''
  if (invoiceNumber.length > INVOICE_NUMBER_MAX || notes.length > PAYMENT_NOTES_MAX)
    return fail('too_long')
  // A form without the version it loaded cannot show it is up to date.
  if (!version) return fail('not_open')
  try {
    await payload.update({
      collection: 'payments',
      id,
      data: {
        invoiceNumber: invoiceNumber || null,
        invoiceSentAt: invoiceSent ? dayToStored(invoiceSent) : null,
        invoicePaidAt: invoicePaid ? dayToStored(invoicePaid) : null,
        studentPaidAt: studentPaid ? dayToStored(studentPaid) : null,
        notes: notes || null,
      },
      context: { paymentVersion: version } satisfies PaymentContext,
      ...asActor(actor),
    })
    return { status: 'saved', doneAt: Date.now() }
  } catch (error) {
    const code = paymentErrorCode(error)
    if (code) return fail(code)
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined
    if (status === 404) return fail('not_found')
    if (status === 403) return fail('forbidden')
    return fail('generic')
  }
}
