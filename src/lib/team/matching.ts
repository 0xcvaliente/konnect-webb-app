import { APIError, type Payload, ValidationError } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import {
  decisionDay,
  DECISION_DAYS,
  MAX_RUNNING_PROJECTS,
  RUNNING_PROJECT_STATUSES,
} from '@/lib/applications/fields'
import { applyErrorCode } from '@/lib/applications/rules'
import {
  MATCH_ERRORS,
  type MatchError,
  type MatchState,
  type SharedItem,
  sharedItemsOf,
} from '@/lib/matching/fields'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import type { ApplicationStatus } from '@/lib/transitions'
import { promiseState, type PromiseState } from '@/lib/workingDays'
import type { Application, Cv, Match, Project, StudentProfile } from '@/payload-types'

import { type ActivityRow, activityOf, type Owner, ownersById, type SessionUser } from './approvals'
import { myOwnerIds } from './members'

/**
 * The team's Matching screen (Kanban card "Admin applications queue and manual matching", mockup
 * "Matching"): the published projects with applications to decide, and for one project its brief
 * beside the applicants, compared side by side. Shortlisting and selecting go through the
 * Applications hook (lib/matching/rules.ts), which holds every rule for every API.
 *
 * Every read and write runs through the Local API as the team member with `overrideAccess:
 * false`, so the collections' access rules decide. Nothing here logs names, notes or form values.
 * This is the team's view: it is never used on a company or student page.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

const OPEN_STATUSES: ApplicationStatus[] = ['applied', 'shortlisted']

// ---------- The queue ----------

/** decide: applications have closed, Konnected's 3 working days run. open: still taking them. */
export type MatchingSection = 'decide' | 'open'

export type MatchingItem = {
  id: number
  title: string
  companyName: string | null
  owner: Owner
  /** Applications still waiting for a decision (applied or shortlisted). */
  open: number
  shortlisted: number
  /** `YYYY-MM-DD`, or null when the project has no closing day. */
  closesOn: string | null
  decideBy: string | null
  section: MatchingSection
  /** The decision promise, once applications have closed. */
  due: PromiseState | null
}

/**
 * Published projects with at least one application waiting for a decision. Projects whose
 * applications have closed come first (their decision promise runs), soonest due first; then the
 * ones still open, closing soonest first. `mine` keeps the actor's companies' projects (ownership
 * routes the work; it never limits access).
 */
export async function listMatchingQueue(
  payload: Payload,
  actor: SessionUser | null,
  { mine = false }: { mine?: boolean } = {},
): Promise<MatchingItem[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const applications = await payload.find({
    collection: 'applications',
    where: {
      and: [{ status: { in: OPEN_STATUSES } }, { 'project.status': { equals: 'published' } }],
    },
    depth: 0,
    pagination: false,
    select: { project: true, status: true },
    ...asActor(actor),
  })
  const open = new Map<number, { open: number; shortlisted: number }>()
  for (const a of applications.docs) {
    const id = relationId(a.project)
    if (!id) continue
    const entry = open.get(id) ?? { open: 0, shortlisted: 0 }
    entry.open += 1
    if (a.status === 'shortlisted') entry.shortlisted += 1
    open.set(id, entry)
  }
  if (!open.size) return []

  const projects = await payload.find({
    collection: 'projects',
    where: { id: { in: [...open.keys()] } },
    depth: 0,
    pagination: false,
    select: { title: true, companyName: true, company: true, deadline: true, owner: true },
    ...asActor(actor),
  })
  const owners = await ownersById(
    payload,
    actor,
    projects.docs.map((p) => relationId(p.owner)),
  )
  const today = todayInOslo()

  const items = projects.docs.map((p): MatchingItem => {
    const closesOn = storedToDay(p.deadline)
    const closed = Boolean(closesOn && closesOn < today)
    const counts = open.get(p.id)!
    return {
      id: p.id,
      title: p.title,
      companyName: p.companyName ?? null,
      owner: owners.get(relationId(p.owner) ?? 0) ?? null,
      open: counts.open,
      shortlisted: counts.shortlisted,
      closesOn,
      decideBy: decisionDay(closesOn),
      section: closed ? 'decide' : 'open',
      due:
        closed && closesOn ? promiseState(new Date(`${closesOn}T12:00:00Z`), DECISION_DAYS) : null,
    }
  })
  const order = (item: MatchingItem) => item.decideBy ?? '9999-12-31'
  // Mine: my own items and those of anyone I cover today.
  const ids = mine ? await myOwnerIds(payload, actor) : null
  return items
    .filter((item) => !ids || ids.has(item.owner?.id ?? 0))
    .sort(
      (a, b) =>
        (a.section === b.section ? 0 : a.section === 'decide' ? -1 : 1) ||
        order(a).localeCompare(order(b)) ||
        a.id - b.id,
    )
}

/** Projects with applications to decide, for the menu. */
export async function matchingCount(payload: Payload, actor: SessionUser | null): Promise<number> {
  return (await listMatchingQueue(payload, actor))?.length ?? 0
}

// ---------- One project ----------

export type Applicant = {
  applicationId: number
  status: ApplicationStatus
  appliedAt: string
  note: string | null
  profileId: number
  name: string
  school: string | null
  programme: string | null
  year: number | null
  skills: string[]
  reviewed: boolean
  /** A reviewed profile the student changed since (the team sees what in Approvals). */
  changedSinceReview: boolean
  /** Matched or in progress, other projects. */
  running: number
  /** Workload of those running projects, in hours. */
  runningHours: number
  /** Never matched with Konnected before. */
  firstProject: boolean
  cv: { url: string; name: string } | null
  /** What the company would see if Konnected selects this student: what the student ticked. */
  shares: SharedItem[]
  canSelect: boolean
}

export type Decided = {
  applicationId: number
  status: ApplicationStatus
  name: string
  decidedAt: string | null
}

export type MatchingProject = {
  project: Project
  owner: Owner
  closesOn: string | null
  decideBy: string | null
  due: PromiseState | null
  /** Open applications, shortlisted first, then oldest first. */
  applicants: Applicant[]
  /** Selected, not selected and withdrawn applications. */
  decided: Decided[]
  /** The match, once Konnected selected a student. */
  match: { name: string; at: string; shares: SharedItem[] } | null
  activity: ActivityRow[]
}

/** What the match's copy would hold for this profile: the student's ticks, filled in. */
const sharesOf = (profile: StudentProfile): SharedItem[] => {
  const p = profile.privacy ?? {}
  return sharedItemsOf({
    name: p.shareName ? profile.name : null,
    school: p.shareSchool ? profile.school : null,
    programme: p.shareSchool ? profile.programme : null,
    year: p.shareSchool ? profile.year : null,
    pitch: p.sharePitch ? profile.pitch : null,
    skills: p.shareSkills ? (profile.skills ?? []) : [],
    experience: p.shareExperience ? profile.experience : null,
    cv: p.shareCv ? (relationId(profile.cv) ?? null) : null,
    contactEmail: p.shareContactEmail ? profile.contactEmail : null,
    phone: p.sharePhone ? profile.phone : null,
  })
}

export async function loadMatchingProject(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<MatchingProject | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const project = (await payload.findByID({
    collection: 'projects',
    id,
    depth: 1,
    disableErrors: true,
    ...asActor(actor),
  })) as Project | null
  if (!project) return null
  const owners = await ownersById(payload, actor, [relationId(project.owner)])

  const applications = (
    await payload.find({
      collection: 'applications',
      where: { project: { equals: project.id } },
      depth: 0,
      pagination: false,
      sort: 'createdAt',
      ...asActor(actor),
    })
  ).docs as Application[]
  const profileIds = [...new Set(applications.map((a) => relationId(a.student)).filter(Boolean))]
  const profiles = profileIds.length
    ? ((
        await payload.find({
          collection: 'student-profiles',
          where: { id: { in: profileIds } },
          depth: 1,
          pagination: false,
          ...asActor(actor),
        })
      ).docs as StudentProfile[])
    : []
  const profileOf = new Map(profiles.map((p) => [p.id, p]))

  // Every match of these students, with its project's status and workload: running projects,
  // hours already promised elsewhere, and whether this would be their first project.
  const matches = profileIds.length
    ? ((
        await payload.find({
          collection: 'matches',
          where: { and: [{ student: { in: profileIds } }, ACTIVE_MATCH] },
          depth: 0,
          pagination: false,
          select: { student: true, project: true, createdAt: true },
          ...asActor(actor),
        })
      ).docs as Pick<Match, 'id' | 'student' | 'project' | 'createdAt'>[])
    : []
  const matchedProjectIds = [...new Set(matches.map((m) => relationId(m.project)).filter(Boolean))]
  const matchedProjects = matchedProjectIds.length
    ? (
        await payload.find({
          collection: 'projects',
          where: { id: { in: matchedProjectIds } },
          depth: 0,
          pagination: false,
          select: { status: true, workloadHours: true },
          ...asActor(actor),
        })
      ).docs
    : []
  const projectInfo = new Map(matchedProjects.map((p) => [p.id, p]))
  const running = (profileId: number) =>
    matches.filter((m) => {
      if (relationId(m.student) !== profileId || relationId(m.project) === project.id) return false
      const status = projectInfo.get(relationId(m.project) ?? 0)?.status
      return (RUNNING_PROJECT_STATUSES as readonly string[]).includes(status ?? '')
    })

  const published = project.status === 'published'
  const applicants: Applicant[] = []
  const decided: Decided[] = []
  for (const a of applications) {
    const profile = profileOf.get(relationId(a.student) ?? 0)
    if (!profile) continue
    if (!OPEN_STATUSES.includes(a.status)) {
      decided.push({
        applicationId: a.id,
        status: a.status,
        name: profile.name,
        decidedAt: a.decidedAt ?? a.withdrawnAt ?? null,
      })
      continue
    }
    const runs = running(profile.id)
    const cv = typeof profile.cv === 'object' && profile.cv ? (profile.cv as Cv) : null
    const reviewed = profile.reviewStatus === 'reviewed'
    applicants.push({
      applicationId: a.id,
      status: a.status,
      appliedAt: a.createdAt,
      note: a.note ?? null,
      profileId: profile.id,
      name: profile.name,
      school: profile.school ?? null,
      programme: profile.programme ?? null,
      year: profile.year ?? null,
      skills: profile.skills ?? [],
      reviewed,
      changedSinceReview: reviewed && Boolean(profile.changedSinceReviewAt),
      running: runs.length,
      runningHours: runs.reduce(
        (sum, m) => sum + (projectInfo.get(relationId(m.project) ?? 0)?.workloadHours ?? 0),
        0,
      ),
      firstProject: !matches.some(
        (m) => relationId(m.student) === profile.id && relationId(m.project) !== project.id,
      ),
      cv: cv?.url ? { url: cv.url, name: cv.originalName ?? cv.filename ?? 'CV.pdf' } : null,
      shares: sharesOf(profile),
      canSelect: published && reviewed && runs.length < MAX_RUNNING_PROJECTS,
    })
  }
  applicants.sort(
    (a, b) =>
      (a.status === b.status ? 0 : a.status === 'shortlisted' ? -1 : 1) ||
      a.appliedAt.localeCompare(b.appliedAt),
  )

  const own = await payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: project.id } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    ...asActor(actor),
  })
  const matchDoc = own.docs[0] as Match | undefined
  const matchedProfile = matchDoc ? profileOf.get(relationId(matchDoc.student) ?? 0) : undefined

  const closesOn = storedToDay(project.deadline)
  const closed = Boolean(closesOn && closesOn < todayInOslo())
  return {
    project,
    owner: owners.get(relationId(project.owner) ?? 0) ?? null,
    closesOn,
    decideBy: decisionDay(closesOn),
    due:
      published && closed && closesOn
        ? promiseState(new Date(`${closesOn}T12:00:00Z`), DECISION_DAYS)
        : null,
    applicants,
    decided,
    match: matchDoc
      ? {
          name: matchedProfile?.name ?? '',
          at: matchDoc.createdAt,
          shares: sharedItemsOf(matchDoc.sharedInfo),
        }
      : null,
    activity: await activityOf(payload, actor, 'projects', project.id),
  }
}

// ---------- Decisions ----------

const done = (): MatchState => ({ status: 'done', doneAt: Date.now() })
const fail = (error: MatchError): MatchState => ({ status: 'error', error, doneAt: Date.now() })

const idOf = (form: FormData): number | undefined => {
  const value = form.get('id')
  const id = typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : 0
  return id > 0 ? id : undefined
}

/** Payload's refusal as an answer for the screen. Never throws. */
async function refused(
  payload: Payload,
  actor: SessionUser,
  application: Application,
  error: unknown,
): Promise<MatchState> {
  const code = applyErrorCode(error) as string | undefined
  if (code && (MATCH_ERRORS as readonly string[]).includes(code)) return fail(code as MatchError)
  // Two team members selecting at once: the database refused the second match for the project
  // (unique). Look again: the project has its student now.
  const projectId = relationId(application.project)
  if (projectId) {
    const matched = await payload.count({
      collection: 'matches',
      where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
      ...asActor(actor),
    })
    if (matched.totalDocs > 0) return fail('already_matched')
  }
  const status =
    error instanceof APIError || error instanceof ValidationError
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 404) return fail('not_found')
  if (status === 400 || status === 403 || status === 409) return fail('not_open')
  payload.logger.error({
    msg: 'Matching decision failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

type Decision = (payload: Payload, actor: SessionUser | null, form: FormData) => Promise<MatchState>

async function decide(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
  to: 'shortlisted' | 'selected',
): Promise<MatchState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const id = idOf(form)
  if (!id) return fail('not_found')
  const application = (await payload.findByID({
    collection: 'applications',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Application | null
  if (!application) return fail('not_found')
  const allowed: ApplicationStatus[] = to === 'shortlisted' ? ['applied'] : OPEN_STATUSES
  if (!allowed.includes(application.status)) return fail('not_open')
  try {
    await payload.update({
      collection: 'applications',
      id,
      data: { status: to },
      ...asActor(actor),
    })
  } catch (error) {
    return refused(payload, actor, application, error)
  }
  return done()
}

/** Put an applied application on the shortlist. */
export const shortlistApplication: Decision = (payload, actor, form) =>
  decide(payload, actor, form, 'shortlisted')

/**
 * Select one application. The Applications hook checks every rule again and, in the same
 * transaction, creates the match, marks the others not selected, moves the project to matched and
 * sends the emails.
 */
export const selectApplication: Decision = (payload, actor, form) =>
  decide(payload, actor, form, 'selected')
