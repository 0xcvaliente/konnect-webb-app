import type { Payload } from 'payload'

import { isStudent } from '@/access/roles'
import { type SharedItem, sharedItemsOf } from '@/lib/matching/fields'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import { findOwnProfile, type SessionUser } from '@/lib/students/profile'
import type { ApplicationStatus } from '@/lib/transitions'
import type { Application, CompanyLogo, Project } from '@/payload-types'

import {
  type ApplicationSort,
  type ApplyError,
  type ApplyState,
  canWithdraw,
  decisionDay,
  MAX_RUNNING_PROJECTS,
  NOTE_MAX,
  STATUS_ORDER,
  type WithdrawError,
  type WithdrawState,
} from './fields'
import { applyErrorCode, runningProjectCount } from './rules'

/**
 * The student's side of applications: the apply box on a project page, applying, My applications
 * and one application with its progress, and withdrawing.
 *
 * Every read and write goes through the Local API as the student with `overrideAccess: false`, so
 * the Applications access rule (own applications only) and its hook (the apply rules) decide. The
 * checks here come first only to give clear answers. Companies and the team get null everywhere:
 * this is the student's view. Nothing here logs the note or any personal data.
 */

const asStudent = (user: SessionUser) => ({ user, overrideAccess: false as const })

/** What the apply box on a project page shows. */
export type ApplyBox =
  | { kind: 'applied'; applicationId: number; status: ApplicationStatus }
  | { kind: 'withdrawn'; applicationId: number }
  | { kind: 'too_many'; running: number }
  | { kind: 'changes_requested' }
  | { kind: 'open'; profileWaiting: boolean; decideBy: string | null }

/**
 * The apply box for one published project, for the signed-in student. Null for anyone else. The
 * project page decides "open or closed" from the project itself; this says what the student may do.
 */
export async function applyBoxFor(
  payload: Payload,
  user: SessionUser | null,
  projectId: number,
  closingDay: string | null,
): Promise<ApplyBox | null> {
  if (!user || !isStudent(user)) return null
  const profile = await findOwnProfile(payload, user)
  if (!profile) return null
  const own = await payload.find({
    collection: 'applications',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 0,
    select: { status: true },
    ...asStudent(user),
  })
  const existing = own.docs[0]
  if (existing?.status === 'withdrawn') return { kind: 'withdrawn', applicationId: existing.id }
  if (existing) return { kind: 'applied', applicationId: existing.id, status: existing.status }
  const running = await runningProjectCount(payload, profile.id)
  if (running >= MAX_RUNNING_PROJECTS) return { kind: 'too_many', running }
  const review = profile.reviewStatus ?? 'waiting'
  if (review === 'changes_requested') return { kind: 'changes_requested' }
  return { kind: 'open', profileWaiting: review !== 'reviewed', decideBy: decisionDay(closingDay) }
}

const fail = (error: ApplyError): ApplyState => ({ status: 'error', error, doneAt: Date.now() })

/**
 * Apply to a project as the signed-in student. The student comes from the session, never from the
 * form; the form carries only the project id and the note. The hook re-checks every rule.
 */
export async function applyToProject(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<ApplyState> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const rawId = form.get('projectId')
  const projectId = typeof rawId === 'string' && /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0
  if (!projectId) return fail('not_open')
  const rawNote = form.get('note')
  const note = typeof rawNote === 'string' ? rawNote.trim() : ''
  if (!note) return fail('note_required')
  if (note.length > NOTE_MAX) return fail('note_too_long')

  try {
    const created = await payload.create({
      collection: 'applications',
      data: { project: projectId, note } as Pick<Application, 'project' | 'note'> as never,
      ...asStudent(user),
    })
    return { status: 'done', applicationId: created.id, doneAt: Date.now() }
  } catch (error) {
    const code = applyErrorCode(error)
    if (code) return fail(code)
    // Two requests at the same moment: the unique index refused this one (Payload reports it as
    // a validation error). Look again: an application for this project is there now.
    const now = await payload.find({
      collection: 'applications',
      where: { project: { equals: projectId } },
      limit: 1,
      depth: 0,
      select: { status: true },
      ...asStudent(user),
    })
    if (now.docs[0])
      return fail(now.docs[0].status === 'withdrawn' ? 'withdrawn_before' : 'already_applied')
    return fail('generic')
  }
}

/** Withdraw one of the student's own applications, while Konnected is still deciding. */
export async function withdrawApplication(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<WithdrawState> {
  const failW = (error: WithdrawError): WithdrawState => ({
    status: 'error',
    error,
    doneAt: Date.now(),
  })
  if (!user || !isStudent(user)) return failW('forbidden')
  const rawId = form.get('applicationId')
  const id = typeof rawId === 'string' && /^\d{1,10}$/.test(rawId) ? Number(rawId) : 0
  if (!id) return failW('not_found')
  const found = await payload.find({
    collection: 'applications',
    where: { id: { equals: id } },
    limit: 1,
    depth: 0,
    select: { status: true },
    ...asStudent(user),
  })
  const application = found.docs[0]
  if (!application) return failW('not_found')
  if (!canWithdraw(application.status)) return failW('not_withdrawable')
  try {
    await payload.update({
      collection: 'applications',
      id,
      data: { status: 'withdrawn' },
      ...asStudent(user),
    })
    return { status: 'done', doneAt: Date.now() }
  } catch {
    return failW('generic')
  }
}

/** One application as the student's pages show it. Dates are ISO strings or `YYYY-MM-DD`. */
export type OwnApplication = {
  id: number
  status: ApplicationStatus
  note: string | null
  appliedAt: string
  shortlistedAt: string | null
  decidedAt: string | null
  withdrawnAt: string | null
  /** When Konnected ended the match made from this application. */
  endedAt: string | null
  /** The last change, for "most recent". */
  updatedAt: string
  /** The project's id, for the link to its page while it is still listed. */
  projectId: number | null
  title: string
  companyName: string
  /** Applications close on this day (`YYYY-MM-DD`). */
  closingDay: string | null
  /** Applications are still open today. */
  open: boolean
  /** Konnected decides by this day (3 working days after applications close). */
  decideBy: string | null
  /**
   * The project while it is still published (a student reads published projects only). Null once
   * Konnected has matched or closed it; the title, company and closing day above are then the
   * copies kept when the student applied.
   */
  listed: {
    logoUrl: string | null
    workloadHours: number | null
    durationWeeks: number | null
    deliverable: string | null
    paidOrUnpaid: Project['paidOrUnpaid'] | null
  } | null
}

const PROJECT_SELECT = {
  title: true,
  companyName: true,
  companyLogo: true,
  workloadHours: true,
  durationWeeks: true,
  deliverable: true,
  paidOrUnpaid: true,
  deadline: true,
} as const

const APPLICATION_SELECT = {
  status: true,
  note: true,
  project: true,
  projectTitle: true,
  companyName: true,
  closesOn: true,
  shortlistedAt: true,
  decidedAt: true,
  withdrawnAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

const toOwn = (doc: Application, today: string): OwnApplication => {
  // A project the student may no longer read comes back as its id only.
  const project = typeof doc.project === 'object' && doc.project ? (doc.project as Project) : null
  const projectId = project?.id ?? (typeof doc.project === 'number' ? doc.project : null)
  const closingDay = storedToDay(project ? project.deadline : doc.closesOn)
  const logo = project?.companyLogo
  return {
    id: doc.id,
    status: doc.status,
    note: doc.note ?? null,
    appliedAt: doc.createdAt,
    shortlistedAt: doc.shortlistedAt ?? null,
    decidedAt: doc.decidedAt ?? null,
    withdrawnAt: doc.withdrawnAt ?? null,
    endedAt: doc.endedAt ?? null,
    updatedAt: doc.updatedAt,
    projectId,
    title: project?.title ?? doc.projectTitle ?? '',
    companyName: project?.companyName ?? doc.companyName ?? '',
    closingDay,
    open: Boolean(project) && (!closingDay || closingDay >= today),
    decideBy: decisionDay(closingDay),
    listed: project
      ? {
          logoUrl:
            typeof logo === 'object' && logo !== null ? ((logo as CompanyLogo).url ?? null) : null,
          workloadHours: project.workloadHours ?? null,
          durationWeeks: project.durationWeeks ?? null,
          deliverable: project.deliverable ?? null,
          paidOrUnpaid: project.paidOrUnpaid ?? null,
        }
      : null,
  }
}

const SORTERS: Record<ApplicationSort, (a: OwnApplication, b: OwnApplication) => number> = {
  need: (a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.localeCompare(a.updatedAt),
  recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  company: (a, b) =>
    a.companyName.localeCompare(b.companyName, 'nb') ||
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
}

/** Bounded: a student has few applications; the list reads at most 200. */
const LIST_LIMIT = 200

/** The signed-in student's applications, sorted. Null for anyone else. */
export async function listOwnApplications(
  payload: Payload,
  user: SessionUser | null,
  sort: ApplicationSort = 'need',
  today: string = todayInOslo(),
): Promise<OwnApplication[] | null> {
  if (!user || !isStudent(user)) return null
  const found = await payload.find({
    collection: 'applications',
    where: { 'student.user': { equals: user.id } },
    depth: 2,
    limit: LIST_LIMIT,
    sort: '-createdAt',
    select: APPLICATION_SELECT,
    populate: { projects: PROJECT_SELECT, 'company-logos': { url: true } },
    ...asStudent(user),
  })
  return found.docs.map((doc) => toOwn(doc as Application, today)).sort(SORTERS[sort])
}

/** One of the signed-in student's own applications, or null. */
export async function findOwnApplication(
  payload: Payload,
  user: SessionUser | null,
  id: number,
  today: string = todayInOslo(),
): Promise<OwnApplication | null> {
  if (!user || !isStudent(user) || !Number.isInteger(id) || id <= 0) return null
  const found = await payload.find({
    collection: 'applications',
    where: { id: { equals: id } },
    depth: 2,
    limit: 1,
    select: APPLICATION_SELECT,
    populate: { projects: PROJECT_SELECT, 'company-logos': { url: true } },
    ...asStudent(user),
  })
  const doc = found.docs[0] as Application | undefined
  if (!doc) return null
  return toOwn(doc, today)
}

/**
 * For a selected application: what Konnected shares with the company, from the student's own
 * match (the copy of what the student ticked). Read as the student with access control on: a
 * student reads only their own matches. Null before selection and for anyone else.
 */
export async function ownSharedItems(
  payload: Payload,
  user: SessionUser | null,
  projectId: number | null,
): Promise<SharedItem[] | null> {
  if (!user || !isStudent(user) || !projectId) return null
  const found = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 0,
    select: { sharedInfo: true },
    ...asStudent(user),
  })
  const match = found.docs[0]
  return match ? sharedItemsOf(match.sharedInfo) : null
}
