import { APIError, type Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { agreementGateOf } from '@/lib/agreements/gates'
import {
  type CloseOutcome,
  cleanText,
  type ProblemError,
  problemErrorCode,
  type ProblemKind,
  type ProblemResolution,
  type ProblemState,
  PROBLEM_NOTE_MAX,
  REASON_MAX,
  type ReopenReason,
} from '@/lib/problems/fields'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { parsePrice } from '@/lib/money'
import { dayToStored, parseDay, storedToDay, todayInOslo } from '@/lib/projects/fields'
import type { ProjectStatus } from '@/lib/transitions'
import type { Match, ProblemReport, Project, StudentProfile } from '@/payload-types'

import { type ActivityRow, activityOf, type SessionUser } from './approvals'
import { PARTY_SIGNED, PAY_EDITABLE, type PayChangeError, type PayChangeState } from './payChange'

/**
 * The team's project page and the problem paths (Kanban cards "Problem reports: more time, match
 * again, close without delivery" and "Projects without a match: reopen, ask for changes, close"),
 * plus the lists for Today. Every read and write runs through the Local API as the team member
 * with `overrideAccess: false`; the Projects, Matches and ProblemReports hooks hold the rules and
 * write the activity log. Nothing here logs notes or names.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

/** A day (`YYYY-MM-DD`) from a stored date, or null. */
const day = (value: unknown) => storedToDay(value)

export type TeamMatch = {
  id: number
  studentName: string
  applicationId: number | null
  /** `YYYY-MM-DD` or null. */
  startDay: string | null
  dueDay: string | null
  /** The due dates before, oldest first. */
  history: { from: string | null; to: string | null; changedAt: string }[]
  endedAt: string | null
}

export type TeamReport = {
  id: number
  kind: ProblemKind
  /** The student's own words. For the team only. */
  note: string
  status: 'open' | 'resolved'
  resolution: ProblemResolution | null
  createdAt: string
  resolvedAt: string | null
  studentName: string
}

export type TeamProject = {
  id: number
  title: string
  companyName: string
  status: ProjectStatus
  paid: boolean
  /** Applications close on this day (`YYYY-MM-DD`), or null. */
  closesOn: string | null
  /** Applications have closed (the closing day is before today). */
  applicationsClosed: boolean
  applications: { total: number; open: number }
  match: TeamMatch | null
  endedMatches: TeamMatch[]
  openReport: TeamReport | null
  reports: TeamReport[]
  /** Published, no student, and applications closed: the "no good match" choices apply. */
  noMatch: boolean
  noteToCompany: string | null
  closeOutcome: CloseOutcome | null
  closeReason: string | null
  closedAt: string | null
  reopenedAt: string | null
  reopenReason: ReopenReason | null
  /** The project's owner on the team (team split by company), or null. */
  ownerId: number | null
  /** The company's owner, whom the project follows unless the team moved it. */
  companyOwnerId: number | null
  /** The price and the student's pay, for a paid project; null for an unpaid one. */
  pay: TeamPay | null
  activity: ActivityRow[]
}

export type TeamPay = {
  /** The fixed price excluding VAT, and what the student is paid (whole kroner), or null. */
  fee: number | null
  studentPay: number | null
  /** The team may change both here now (a paid project, published or later, not closed). */
  editable: boolean
  /** The company signed the project's company agreement (Konnected may still have to sign). */
  companySigned: boolean
  /** The student signed the current match's student agreement. */
  studentSigned: boolean
  /** The current match has a payment log row. */
  paymentRow: boolean
  /** The day the invoice of the current match was sent (`YYYY-MM-DD`), or null. */
  invoiceSent: string | null
}

/**
 * The project's price and pay with what a change touches: agreements the company or the student
 * signed (they keep the old amount), and the current match's payment log row. Read as the team
 * member.
 */
async function payOf(
  payload: Payload,
  actor: SessionUser,
  project: Project,
  matchId: number | null,
): Promise<TeamPay | null> {
  if (project.paidOrUnpaid !== 'paid') return null
  const [agreements, payments] = await Promise.all([
    payload.find({
      collection: 'agreements',
      where: {
        and: [
          { project: { equals: project.id } },
          { status: { in: [...PARTY_SIGNED] } },
          matchId
            ? { or: [{ kind: { equals: 'company' } }, { match: { equals: matchId } }] }
            : { kind: { equals: 'company' } },
        ],
      },
      depth: 0,
      pagination: false,
      select: { kind: true },
      ...asActor(actor),
    }),
    matchId
      ? payload.find({
          collection: 'payments',
          where: { match: { equals: matchId } },
          depth: 0,
          limit: 1,
          select: { invoiceSentAt: true },
          ...asActor(actor),
        })
      : Promise.resolve(null),
  ])
  const row = payments?.docs[0]
  return {
    fee: project.fee ?? null,
    studentPay: project.studentPay ?? null,
    editable: (PAY_EDITABLE as readonly string[]).includes(project.status),
    companySigned: agreements.docs.some((a) => a.kind === 'company'),
    studentSigned: agreements.docs.some((a) => a.kind === 'student'),
    paymentRow: Boolean(row),
    invoiceSent: day(row?.invoiceSentAt),
  }
}

const toMatch = (m: Match, names: Map<number, string>): TeamMatch => ({
  id: m.id,
  studentName: names.get(relationId(m.student as number) ?? 0) ?? '',
  applicationId: relationId(m.application as number) ?? null,
  startDay: day(m.startDate),
  dueDay: day(m.endDate),
  history: (m.dueDateHistory ?? []).map((h) => ({
    from: day(h.from),
    to: day(h.to),
    changedAt: h.changedAt ?? m.updatedAt,
  })),
  endedAt: m.endedAt ?? null,
})

/** One project with its matches, problem reports and applications, read as the team member. */
export async function loadTeamProject(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<TeamProject | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id <= 0) return null
  const project = (await payload.findByID({
    collection: 'projects',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Project | null
  if (!project) return null
  const [matches, reports, applications, activity] = await Promise.all([
    payload.find({
      collection: 'matches',
      where: { project: { equals: id } },
      depth: 0,
      pagination: false,
      sort: '-createdAt',
      ...asActor(actor),
    }),
    payload.find({
      collection: 'problem-reports',
      where: { project: { equals: id } },
      depth: 0,
      pagination: false,
      sort: '-createdAt',
      ...asActor(actor),
    }),
    payload.find({
      collection: 'applications',
      where: { project: { equals: id } },
      depth: 0,
      pagination: false,
      select: { status: true },
      ...asActor(actor),
    }),
    activityOf(payload, actor, 'projects', id),
  ])
  const studentIds = [
    ...new Set(
      [...matches.docs, ...reports.docs]
        .map((d) => relationId((d as Match).student as number))
        .filter(Boolean),
    ),
  ] as number[]
  const profiles = studentIds.length
    ? await payload.find({
        collection: 'student-profiles',
        where: { id: { in: studentIds } },
        depth: 0,
        pagination: false,
        select: { name: true },
        ...asActor(actor),
      })
    : { docs: [] as Pick<StudentProfile, 'id' | 'name'>[] }
  const names = new Map(profiles.docs.map((p) => [p.id, p.name ?? '']))
  const all = (matches.docs as Match[]).map((m) => toMatch(m, names))
  const match = all.find((m) => !m.endedAt) ?? null
  const toReport = (r: ProblemReport): TeamReport => ({
    id: r.id,
    kind: r.kind,
    note: r.note,
    status: r.status,
    resolution: r.resolution ?? null,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? null,
    studentName: names.get(relationId(r.student as number) ?? 0) ?? '',
  })
  const allReports = (reports.docs as ProblemReport[]).map(toReport)
  const closesOn = day(project.deadline)
  const applicationsClosed = Boolean(closesOn && closesOn < todayInOslo())
  return {
    id: project.id,
    title: project.title,
    companyName: project.companyName ?? '',
    status: project.status,
    paid: project.paidOrUnpaid === 'paid',
    closesOn,
    applicationsClosed,
    applications: {
      total: applications.docs.length,
      open: applications.docs.filter((a) => a.status === 'applied' || a.status === 'shortlisted')
        .length,
    },
    match,
    endedMatches: all.filter((m) => m.endedAt),
    openReport: allReports.find((r) => r.status === 'open') ?? null,
    reports: allReports,
    noMatch: project.status === 'published' && !match && applicationsClosed,
    noteToCompany: project.noteToCompany ?? null,
    closeOutcome: (project.closeOutcome as CloseOutcome | null | undefined) ?? null,
    closeReason: project.closeReason ?? null,
    closedAt: project.closedAt ?? null,
    reopenedAt: project.reopenedAt ?? null,
    reopenReason: (project.reopenReason as ReopenReason | null | undefined) ?? null,
    ownerId: relationId(project.owner as number) ?? relationId(project.takenBy as number) ?? null,
    companyOwnerId: await companyOwnerOf(payload, actor, relationId(project.company as number)),
    pay: await payOf(payload, actor, project, match?.id ?? null),
    activity,
  }
}

/** The owner on the team of a company, read as the team member. */
async function companyOwnerOf(
  payload: Payload,
  actor: SessionUser,
  companyId: number | undefined,
): Promise<number | null> {
  if (!companyId) return null
  const company = await payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    select: { teamOwner: true },
    disableErrors: true,
    ...asActor(actor),
  })
  return relationId(company?.teamOwner as number) ?? null
}

// ---------- Lists for Today ----------

export type ProblemItem = {
  id: number
  projectId: number
  title: string
  companyName: string
  studentName: string
  kind: ProblemKind
  /** When the student reported (ISO). */
  since: string
  /** The project's owner on the team, or null. */
  ownerId: number | null
}

/** Open problem reports, oldest first. */
export async function listOpenProblems(
  payload: Payload,
  actor: SessionUser | null,
): Promise<ProblemItem[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const reports = await payload.find({
    collection: 'problem-reports',
    where: { status: { equals: 'open' } },
    depth: 0,
    pagination: false,
    sort: 'createdAt',
    select: { project: true, student: true, kind: true, createdAt: true },
    ...asActor(actor),
  })
  if (!reports.docs.length) return []
  const projectIds = [...new Set(reports.docs.map((r) => relationId(r.project as number)!))]
  const studentIds = [...new Set(reports.docs.map((r) => relationId(r.student as number)!))]
  const [projects, profiles] = await Promise.all([
    payload.find({
      collection: 'projects',
      where: { id: { in: projectIds } },
      depth: 0,
      pagination: false,
      select: { title: true, companyName: true, owner: true },
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
  ])
  const projectOf = new Map(projects.docs.map((p) => [p.id, p]))
  const nameOf = new Map(profiles.docs.map((p) => [p.id, p.name ?? '']))
  return reports.docs.flatMap((r) => {
    const project = projectOf.get(relationId(r.project as number) ?? 0)
    if (!project) return []
    return [
      {
        id: r.id,
        projectId: project.id,
        title: project.title,
        companyName: project.companyName ?? '',
        studentName: nameOf.get(relationId(r.student as number) ?? 0) ?? '',
        kind: r.kind as ProblemKind,
        since: r.createdAt,
        ownerId: relationId(project.owner as number) ?? null,
      },
    ]
  })
}

export type NoMatchItem = {
  projectId: number
  title: string
  companyName: string
  /** Applications closed on this day (`YYYY-MM-DD`). */
  closedOn: string
  /** Applications still waiting for a decision. */
  open: number
  /** The project's owner on the team, or null. */
  ownerId: number | null
}

/** Published projects whose applications closed without a student, closed longest ago first. */
export async function listProjectsWithoutMatch(
  payload: Payload,
  actor: SessionUser | null,
): Promise<NoMatchItem[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const today = todayInOslo()
  const projects = await payload.find({
    collection: 'projects',
    where: {
      and: [{ status: { equals: 'published' } }, { deadline: { less_than: dayToStored(today) } }],
    },
    depth: 0,
    pagination: false,
    sort: 'deadline',
    select: { title: true, companyName: true, deadline: true, owner: true },
    ...asActor(actor),
  })
  const late = projects.docs.filter((p) => {
    const closes = day(p.deadline)
    return closes && closes < today
  })
  if (!late.length) return []
  const ids = late.map((p) => p.id)
  const [matches, applications] = await Promise.all([
    payload.find({
      collection: 'matches',
      where: { and: [{ project: { in: ids } }, ACTIVE_MATCH] },
      depth: 0,
      pagination: false,
      select: { project: true },
      ...asActor(actor),
    }),
    payload.find({
      collection: 'applications',
      where: {
        and: [{ project: { in: ids } }, { status: { in: ['applied', 'shortlisted'] } }],
      },
      depth: 0,
      pagination: false,
      select: { project: true },
      ...asActor(actor),
    }),
  ])
  const matched = new Set(matches.docs.map((m) => relationId(m.project as number)))
  const openOf = new Map<number, number>()
  for (const a of applications.docs) {
    const pid = relationId(a.project as number)!
    openOf.set(pid, (openOf.get(pid) ?? 0) + 1)
  }
  return late
    .filter((p) => !matched.has(p.id))
    .map((p) => ({
      projectId: p.id,
      title: p.title,
      companyName: p.companyName ?? '',
      closedOn: day(p.deadline)!,
      open: openOf.get(p.id) ?? 0,
      ownerId: relationId(p.owner as number) ?? null,
    }))
}

// ---------- The team's decisions ----------

const fail = (error: ProblemError): ProblemState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})
const ok = (): ProblemState => ({ status: 'done', doneAt: Date.now() })

const text = (form: FormData, key: string): string => {
  const value = form.get(key)
  return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n') : ''
}

const idOf = (form: FormData): number | undefined => {
  const id = Number(text(form, 'id'))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** A typed day (`YYYY-MM-DD`), today or later in Oslo. */
function futureDay(form: FormData, key: string): string | ProblemError {
  const typed = parseDay(text(form, key))
  if (!typed || typed < todayInOslo()) return 'date_invalid'
  return typed
}

/** Payload's refusals as answers for the page. Never throws: a throwing action loses the page. */
function refused(payload: Payload, error: unknown): ProblemState {
  const code = problemErrorCode(error)
  if (code) return fail(code)
  if (agreementGateOf(error)) return fail('not_open')
  const status =
    error instanceof APIError || (typeof error === 'object' && error && 'status' in error)
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 404) return fail('not_found')
  if (status === 400 || status === 403 || status === 409) return fail('not_open')
  payload.logger.error({
    msg: 'Team problem-path decision failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/** The project a form is about, read as the team member. */
async function projectOf(payload: Payload, actor: SessionUser, form: FormData) {
  const id = idOf(form)
  if (!id) return null
  return (await payload.findByID({
    collection: 'projects',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Project | null
}

async function activeMatch(payload: Payload, actor: SessionUser, projectId: number) {
  const found = await payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    ...asActor(actor),
  })
  return (found.docs[0] as Match | undefined) ?? null
}

type Decision = (
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
) => Promise<ProblemState>

/**
 * Move the due date of a running project (or set it in answer to the student's report). The
 * Matches hook keeps the old date, logs the change with the team's note, settles the open report
 * and emails the student and the company.
 */
export const moveDueDate: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const due = futureDay(form, 'date')
  if (due === 'date_invalid') return fail(due)
  const note = text(form, 'note')
  if (note.length > REASON_MAX) return fail('reason_too_long')
  const project = await projectOf(payload, actor, form)
  if (!project) return fail('not_found')
  if (project.status !== 'matched' && project.status !== 'in_progress') return fail('not_open')
  const match = await activeMatch(payload, actor, project.id)
  if (!match) return fail('not_open')
  if (day(match.endDate) === due) return fail('date_same')
  try {
    await payload.update({
      collection: 'matches',
      id: match.id,
      data: { endDate: dayToStored(due as string) },
      ...asActor(actor),
      context: note ? { activityNote: note } : undefined,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/**
 * End the match and take applications again until the typed day. The Projects hook ends the match
 * (nothing unreleased is ever released), marks the student's application, settles the report and
 * sends the emails, in one transaction.
 */
export const endMatchAndReopen: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const closes = futureDay(form, 'date')
  if (closes === 'date_invalid') return fail(closes)
  const note = text(form, 'note')
  if (note.length > REASON_MAX) return fail('reason_too_long')
  const project = await projectOf(payload, actor, form)
  if (!project) return fail('not_found')
  if (project.status !== 'matched' && project.status !== 'in_progress') return fail('not_open')
  return saveProject(
    payload,
    actor,
    project.id,
    { status: 'published', deadline: dayToStored(closes as string) },
    note,
  )
}

/**
 * Close the project without delivery (matched or in progress: the match ends) or without a match
 * (published). The reason goes to the company and, after a match, to the student.
 */
export const closeWithoutDelivery: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const reason = cleanText(text(form, 'reason'))
  if (!reason) return fail('reason_required')
  if (reason.length > REASON_MAX) return fail('reason_too_long')
  const project = await projectOf(payload, actor, form)
  if (!project) return fail('not_found')
  if (!['published', 'matched', 'in_progress'].includes(project.status)) return fail('not_open')
  return saveProject(payload, actor, project.id, { status: 'closed', closeReason: reason }, reason)
}

/** Open applications again on a published project nobody was selected for, until the typed day. */
export const reopenApplications: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const closes = futureDay(form, 'date')
  if (closes === 'date_invalid') return fail(closes)
  const project = await projectOf(payload, actor, form)
  if (!project) return fail('not_found')
  if (project.status !== 'published' || (await activeMatch(payload, actor, project.id)))
    return fail('not_open')
  const was = day(project.deadline)
  if (!was || was >= todayInOslo()) return fail('not_open')
  return saveProject(payload, actor, project.id, { deadline: dayToStored(closes as string) })
}

/** Send a published project nobody fitted back to the company, with what to change. */
export const askCompanyForChanges: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = cleanText(text(form, 'note'))
  if (!note) return fail('note_required')
  if (note.length > REASON_MAX) return fail('note_too_long')
  const project = await projectOf(payload, actor, form)
  if (!project) return fail('not_found')
  if (project.status !== 'published') return fail('not_open')
  return saveProject(
    payload,
    actor,
    project.id,
    { status: 'changes_requested', noteToCompany: note },
    note,
  )
}

/** The team talked to the student and nothing changes: settle the report as handled. */
export const markReportHandled: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const id = Number(text(form, 'reportId'))
  if (!Number.isInteger(id) || id <= 0) return fail('not_found')
  const note = text(form, 'note')
  if (note.length > PROBLEM_NOTE_MAX) return fail('note_too_long')
  const report = await payload.findByID({
    collection: 'problem-reports',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })
  if (!report) return fail('not_found')
  if (report.status !== 'open') return fail('changed')
  try {
    await payload.update({
      collection: 'problem-reports',
      id,
      data: { status: 'resolved', resolution: 'no_change' },
      ...asActor(actor),
      context: note ? { activityNote: note } : undefined,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

async function saveProject(
  payload: Payload,
  actor: SessionUser,
  id: number,
  data: Partial<Project>,
  note?: string,
): Promise<ProblemState> {
  try {
    await payload.update({
      collection: 'projects',
      id,
      data,
      ...asActor(actor),
      context: note ? { activityNote: note } : undefined,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

// ---------- Price and student pay after publishing (owner answer 42) ----------

const payFail = (error: PayChangeError): PayChangeState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

/** A typed amount: empty is null, anything else must be whole kroner. */
const amountOf = (form: FormData, key: string): number | null | undefined => {
  const typed = text(form, key)
  return typed ? parsePrice(typed) : null
}

/** What the form loaded (`wasFee`, `wasPay`): empty is null. */
const wasOf = (form: FormData, key: string): number | null => {
  const typed = text(form, key)
  return typed && /^\d+$/.test(typed) ? Number(typed) : null
}

/**
 * Change a published (or later) paid project's price and what the student is paid, as the team
 * member. A new price after the company signed its agreement, or a new pay after the student signed
 * theirs, needs the team's confirmation (`confirm` = `1`) that the signed agreement keeps the old
 * amount: Konnected does not make agreements again automatically. Refused when the amounts changed since the form loaded.
 *
 * The Projects hook checks the rules again (only admins write either field; the pay is at most the
 * price), logs each change with the old and new amount and who made it, and moves a new price onto
 * the current match's payment log row while no invoice was sent.
 */
export async function changeProjectPay(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<PayChangeState> {
  if (!actor || !isAdmin(actor)) return payFail('forbidden')
  const fee = amountOf(form, 'price')
  if (fee === undefined || fee === null) return payFail('price_invalid')
  const studentPay = amountOf(form, 'studentPay')
  if (studentPay === undefined || (studentPay !== null && studentPay > fee))
    return payFail('student_pay_invalid')
  const project = await projectOf(payload, actor, form)
  if (!project) return payFail('not_found')
  if (
    project.paidOrUnpaid !== 'paid' ||
    !(PAY_EDITABLE as readonly string[]).includes(project.status)
  )
    return payFail('not_open')
  const nowFee = project.fee ?? null
  const nowPay = project.studentPay ?? null
  if (wasOf(form, 'wasFee') !== nowFee || wasOf(form, 'wasPay') !== nowPay)
    return payFail('changed')
  if (fee === nowFee && studentPay === nowPay) return payFail('same')
  const match = await activeMatch(payload, actor, project.id)
  const pay = await payOf(payload, actor, project, match?.id ?? null)
  // A new price after the company signed, or a new pay after the student signed: the team
  // confirms that the signed agreement keeps the old amount (it is not made again).
  const signedOld =
    (fee !== nowFee && pay?.companySigned) || (studentPay !== nowPay && pay?.studentSigned)
  if (signedOld && text(form, 'confirm') !== '1') return payFail('confirm')
  try {
    await payload.update({
      collection: 'projects',
      id: project.id,
      data: { fee, studentPay },
      ...asActor(actor),
    })
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined
    if (status === 404) return payFail('not_found')
    if (status === 403) return payFail('forbidden')
    if (status === 400) return payFail('not_open')
    if (status === 409) return payFail('changed')
    payload.logger.error({
      msg: 'Team price change failed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return payFail('generic')
  }
  return { status: 'done', doneAt: Date.now() }
}
