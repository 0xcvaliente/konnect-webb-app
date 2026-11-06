import { APIError, type Payload, type Where } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { formatOrgNumber } from '@/lib/companies/fields'
import { parsePrice } from '@/lib/money'
import {
  changedFields,
  PROFILE_REVIEW_DAYS,
  type ReviewedField,
  type ReviewSnapshot,
  reviewSnapshot,
} from '@/lib/students/fields'
import { promiseState, type PromiseState } from '@/lib/workingDays'
import type {
  ActivityLog,
  Company,
  CompanyLogo,
  Cv,
  Project,
  StudentProfile,
  User,
} from '@/payload-types'

import { NOTE_MAX, type QueueTab, type ReviewError, type ReviewState } from './approvalFields'

/**
 * The team's approval queue ("Konnected team daily work" mockup, Approvals): companies to
 * approve, projects to review and publish, and student profiles to review. Plain functions over
 * Payload so they can be tested without a request; the Server Actions in approvalActions.ts call
 * them with the signed-in user.
 *
 * Every read and write goes through the Local API as the team member with `overrideAccess:
 * false`, so the collections' access rules and hooks decide: transitions, the price on approval,
 * the publishing gate, notes, the activity log and the emails. The checks here come first only to
 * give clear answers. Nothing here logs names, notes or form values.
 */

export type SessionUser = User & { collection: 'users' }

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

// ---------- The queue ----------

/** The team member who owns an item (team split by company), or null for the shared pool. */
export type Owner = { id: number; name: string } | null

/**
 * Where an item sits in its tab. review: waits for a decision. publish: approved, ready to
 * publish. changed: a reviewed profile the student changed since. waiting: the team asked the
 * company or student for something; nothing to do until they answer.
 */
export type QueueSection = 'review' | 'publish' | 'changed' | 'waiting'

export type QueueItem = {
  id: number
  title: string
  /** Project: the company. Student: the school. Company: the organisation number. */
  subtitle: string | null
  /** When the item started waiting in its section. */
  since: string
  owner: Owner
  section: QueueSection
  /** The promise countdown, where Konnected promises a number of working days. */
  due: PromiseState | null
}

const SECTION_ORDER: Record<QueueSection, number> = {
  review: 0,
  publish: 1,
  changed: 2,
  waiting: 3,
}

/** Sections that count as open work for the team (the numbers in the menu and the tabs). */
const OPEN: QueueSection[] = ['review', 'publish', 'changed']

const oldestFirst = (a: QueueItem, b: QueueItem) =>
  SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || a.since.localeCompare(b.since)

const COMPANY_WHERE: Where = { status: { equals: 'pending' } }
const PROJECT_WHERE: Where = { status: { in: ['submitted', 'approved', 'changes_requested'] } }
const PROFILE_WHERE: Where = {
  or: [
    { reviewStatus: { in: ['waiting', 'changes_requested'] } },
    { reviewStatus: { exists: false } },
    {
      and: [{ reviewStatus: { equals: 'reviewed' } }, { changedSinceReviewAt: { exists: true } }],
    },
  ],
}

/** Team members by id, for the owner on each item. */
async function ownersById(
  payload: Payload,
  actor: SessionUser,
  ids: (number | undefined)[],
): Promise<Map<number, Owner>> {
  const wanted = [...new Set(ids.filter((id): id is number => Boolean(id)))]
  if (!wanted.length) return new Map()
  const users = await payload.find({
    collection: 'users',
    where: { id: { in: wanted } },
    depth: 0,
    pagination: false,
    select: { name: true, email: true },
    ...asActor(actor),
  })
  return new Map(users.docs.map((u) => [u.id, { id: u.id, name: u.name || u.email }]))
}

async function companyItems(payload: Payload, actor: SessionUser): Promise<QueueItem[]> {
  const found = await payload.find({
    collection: 'companies',
    where: COMPANY_WHERE,
    depth: 0,
    pagination: false,
    select: {
      name: true,
      orgNumber: true,
      teamOwner: true,
      infoRequestedAt: true,
      reviewRequestedAt: true,
      createdAt: true,
    },
    ...asActor(actor),
  })
  const owners = await ownersById(
    payload,
    actor,
    found.docs.map((c) => relationId(c.teamOwner)),
  )
  return found.docs.map((c) => ({
    id: c.id,
    title: c.name,
    subtitle: c.orgNumber ? formatOrgNumber(c.orgNumber) : null,
    since: (c.infoRequestedAt ?? c.reviewRequestedAt ?? c.createdAt) as string,
    owner: owners.get(relationId(c.teamOwner) ?? 0) ?? null,
    section: c.infoRequestedAt ? 'waiting' : 'review',
    due: null,
  }))
}

async function projectItems(payload: Payload, actor: SessionUser): Promise<QueueItem[]> {
  const found = await payload.find({
    collection: 'projects',
    where: PROJECT_WHERE,
    depth: 0,
    pagination: false,
    select: {
      title: true,
      status: true,
      company: true,
      companyName: true,
      submittedAt: true,
      noteToCompanyAt: true,
      updatedAt: true,
    },
    ...asActor(actor),
  })
  const companyIds = [...new Set(found.docs.map((p) => relationId(p.company)).filter(Boolean))]
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
  const ownerOf = new Map(companies.docs.map((c) => [c.id, relationId(c.teamOwner)]))
  const owners = await ownersById(payload, actor, [...ownerOf.values()])
  return found.docs.map((p) => {
    const section: QueueSection =
      p.status === 'approved' ? 'publish' : p.status === 'changes_requested' ? 'waiting' : 'review'
    return {
      id: p.id,
      title: p.title,
      subtitle: p.companyName ?? null,
      since: (section === 'waiting'
        ? (p.noteToCompanyAt ?? p.updatedAt)
        : section === 'publish'
          ? p.updatedAt
          : (p.submittedAt ?? p.updatedAt)) as string,
      owner: owners.get(ownerOf.get(relationId(p.company) ?? 0) ?? 0) ?? null,
      section,
      due: null,
    }
  })
}

async function profileItems(payload: Payload, actor: SessionUser): Promise<QueueItem[]> {
  const found = await payload.find({
    collection: 'student-profiles',
    where: PROFILE_WHERE,
    depth: 0,
    pagination: false,
    select: {
      name: true,
      school: true,
      reviewStatus: true,
      reviewRequestedAt: true,
      reviewNoteAt: true,
      changedSinceReviewAt: true,
      createdAt: true,
    },
    ...asActor(actor),
  })
  return found.docs.map((s) => {
    const status = s.reviewStatus ?? 'waiting'
    const section: QueueSection =
      status === 'reviewed' ? 'changed' : status === 'changes_requested' ? 'waiting' : 'review'
    const since = (
      section === 'changed'
        ? s.changedSinceReviewAt
        : section === 'waiting'
          ? (s.reviewNoteAt ?? s.createdAt)
          : (s.reviewRequestedAt ?? s.createdAt)
    ) as string
    return {
      id: s.id,
      title: s.name,
      subtitle: s.school ?? null,
      since,
      // Profiles are not split by company: they sit in the shared pool.
      owner: null,
      section,
      // Konnected promises a profile review within 2 working days.
      due: section === 'review' ? promiseState(new Date(since), PROFILE_REVIEW_DAYS) : null,
    }
  })
}

/**
 * One tab of the queue, oldest first within each section. `mine` keeps only the actor's items
 * (ownership routes the work; it never limits access).
 */
export async function listQueue(
  payload: Payload,
  actor: SessionUser | null,
  tab: QueueTab,
  { mine = false }: { mine?: boolean } = {},
): Promise<QueueItem[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const items =
    tab === 'companies'
      ? await companyItems(payload, actor)
      : tab === 'projects'
        ? await projectItems(payload, actor)
        : await profileItems(payload, actor)
  return items.filter((item) => !mine || item.owner?.id === actor.id).sort(oldestFirst)
}

/** Open items per tab (waiting on someone else does not count). */
export async function approvalCounts(
  payload: Payload,
  actor: SessionUser | null,
): Promise<Record<QueueTab, number> | null> {
  if (!actor || !isAdmin(actor)) return null
  const count = async (collection: 'companies' | 'projects' | 'student-profiles', where: Where) =>
    (await payload.count({ collection, where, ...asActor(actor) })).totalDocs
  const [companies, projects, students] = await Promise.all([
    count('companies', {
      and: [{ status: { equals: 'pending' } }, { infoRequestedAt: { exists: false } }],
    }),
    count('projects', { status: { in: ['submitted', 'approved'] } }),
    count('student-profiles', {
      or: [
        { reviewStatus: { equals: 'waiting' } },
        { reviewStatus: { exists: false } },
        {
          and: [
            { reviewStatus: { equals: 'reviewed' } },
            { changedSinceReviewAt: { exists: true } },
          ],
        },
      ],
    }),
  ])
  return { companies, projects, students }
}

export const isOpen = (item: QueueItem) => OPEN.includes(item.section)

// ---------- One item ----------

export type ActivityRow = Pick<
  ActivityLog,
  'id' | 'action' | 'field' | 'fromStatus' | 'toStatus' | 'note' | 'createdAt'
> & { actorName: string | null }

/** The activity log of one record, newest first, read as the team member. */
async function activityOf(
  payload: Payload,
  actor: SessionUser,
  collection: string,
  id: number,
): Promise<ActivityRow[]> {
  const rows = await payload.find({
    collection: 'activity-logs',
    where: {
      and: [{ targetCollection: { equals: collection } }, { targetId: { equals: String(id) } }],
    },
    sort: '-createdAt',
    limit: 30,
    depth: 1,
    ...asActor(actor),
  })
  return rows.docs.map((row) => {
    const by = typeof row.actor === 'object' && row.actor ? row.actor : null
    return {
      id: row.id,
      action: row.action,
      field: row.field,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      note: row.note,
      createdAt: row.createdAt,
      actorName: by ? by.name || by.email : null,
    }
  })
}

export type CompanyReview = {
  company: Company
  logoUrl: string | null
  /** The company user's sign-in address: Konnected's contact. */
  contactEmail: string | null
  owner: Owner
  /** Other companies with the same organisation number (one account per number). */
  sameNumber: Pick<Company, 'id' | 'name' | 'status'>[]
  activity: ActivityRow[]
}

export async function loadCompanyReview(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<CompanyReview | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const company = (await payload.findByID({
    collection: 'companies',
    id,
    depth: 1,
    disableErrors: true,
    ...asActor(actor),
  })) as Company | null
  if (!company) return null
  const user = typeof company.user === 'object' && company.user ? (company.user as User) : null
  const owner =
    typeof company.teamOwner === 'object' && company.teamOwner
      ? {
          id: company.teamOwner.id,
          name: (company.teamOwner as User).name || (company.teamOwner as User).email,
        }
      : null
  const sameNumber = company.orgNumber
    ? (
        await payload.find({
          collection: 'companies',
          where: {
            and: [{ orgNumber: { equals: company.orgNumber } }, { id: { not_equals: company.id } }],
          },
          depth: 0,
          pagination: false,
          select: { name: true, status: true },
          ...asActor(actor),
        })
      ).docs
    : []
  return {
    company,
    logoUrl:
      typeof company.logo === 'object' && company.logo
        ? ((company.logo as CompanyLogo).url ?? null)
        : null,
    contactEmail: user?.email ?? null,
    owner,
    sameNumber,
    activity: await activityOf(payload, actor, 'companies', company.id),
  }
}

export type ProjectReview = {
  project: Project
  company: Pick<Company, 'id' | 'name' | 'status'> | null
  owner: Owner
  activity: ActivityRow[]
}

export async function loadProjectReview(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<ProjectReview | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const project = (await payload.findByID({
    collection: 'projects',
    id,
    depth: 1,
    disableErrors: true,
    ...asActor(actor),
  })) as Project | null
  if (!project) return null
  const company =
    typeof project.company === 'object' && project.company ? (project.company as Company) : null
  const owners = await ownersById(payload, actor, [relationId(company?.teamOwner)])
  return {
    project,
    company: company ? { id: company.id, name: company.name, status: company.status } : null,
    owner: owners.get(relationId(company?.teamOwner) ?? 0) ?? null,
    activity: await activityOf(payload, actor, 'projects', project.id),
  }
}

export type ProfileChange = { field: ReviewedField; before: unknown; after: unknown }

export type ProfileReview = {
  profile: StudentProfile
  /** The student's sign-in address. */
  email: string | null
  cv: (Pick<Cv, 'id' | 'url' | 'filesize'> & { name: string }) | null
  applications: number
  /** What the student changed since the last review (empty when nothing or never reviewed). */
  changes: ProfileChange[]
  activity: ActivityRow[]
}

export async function loadProfileReview(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<ProfileReview | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const profile = (await payload.findByID({
    collection: 'student-profiles',
    id,
    depth: 1,
    disableErrors: true,
    ...asActor(actor),
  })) as StudentProfile | null
  if (!profile) return null
  const user = typeof profile.user === 'object' && profile.user ? (profile.user as User) : null
  const cvDoc = typeof profile.cv === 'object' && profile.cv ? (profile.cv as Cv) : null
  const applications = (
    await payload.count({
      collection: 'applications',
      where: { student: { equals: profile.id } },
      ...asActor(actor),
    })
  ).totalDocs
  const snapshot = (profile.reviewedSnapshot ?? null) as ReviewSnapshot | null
  const now = reviewSnapshot(profile as unknown as Record<string, unknown>)
  const changes = changedFields(snapshot, profile as unknown as Record<string, unknown>).map(
    (field) => ({ field, before: snapshot?.[field] ?? null, after: now[field] ?? null }),
  )
  return {
    profile,
    email: user?.email ?? null,
    cv: cvDoc
      ? {
          id: cvDoc.id,
          url: cvDoc.url,
          filesize: cvDoc.filesize,
          name: cvDoc.originalName ?? cvDoc.filename ?? 'CV.pdf',
        }
      : null,
    applications,
    changes,
    activity: await activityOf(payload, actor, 'student-profiles', profile.id),
  }
}

// ---------- Decisions ----------

const ok = (): ReviewState => ({ status: 'done', doneAt: Date.now() })
const fail = (error: ReviewError): ReviewState => ({ status: 'error', error })

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const idOf = (form: FormData): number | undefined => {
  const id = Number(text(form, 'id'))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** The team's note: required for these decisions, and not longer than the records keep. */
function noteOf(form: FormData): { note: string } | { error: ReviewError } {
  const note = text(form, 'note').replace(/\r\n/g, '\n')
  if (!note) return { error: 'note_required' }
  if (note.length > NOTE_MAX) return { error: 'note_too_long' }
  return { note }
}

/** Payload's refusals as answers for the page. Never throws: a throwing action loses the page. */
function refused(payload: Payload, error: unknown): ReviewState {
  const status =
    error instanceof APIError || (typeof error === 'object' && error && 'status' in error)
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 409) return fail('duplicate_org')
  if (status === 404) return fail('not_found')
  if (status === 400 || status === 403) return fail('not_allowed')
  payload.logger.error({
    msg: 'Team review decision failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

type Target = 'companies' | 'projects' | 'student-profiles'

/** The record a form is about, read as the team member. */
async function load<T extends Target>(
  payload: Payload,
  actor: SessionUser,
  collection: T,
  form: FormData,
) {
  const id = idOf(form)
  if (!id) return null
  return payload.findByID({
    collection,
    id,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })
}

/** Save a decision as the team member; the team's note goes to the activity log row. */
async function save(
  payload: Payload,
  actor: SessionUser,
  collection: Target,
  id: number,
  data: Record<string, unknown>,
  note?: string,
): Promise<ReviewState> {
  try {
    await payload.update({
      collection,
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

type Decision = (
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
) => Promise<ReviewState>

/**
 * Whether Konnected has approved the project's company. Approving and publishing a project need
 * it (the Projects hook and the publishing gate check it again); a company can be rejected, or be
 * back in pending after its one correction, while its project waits in the queue.
 */
async function companyApproved(
  payload: Payload,
  actor: SessionUser,
  project: Project,
): Promise<boolean> {
  const id = relationId(project.company)
  if (!id) return false
  const company = (await payload.findByID({
    collection: 'companies',
    id,
    depth: 0,
    select: { status: true },
    disableErrors: true,
    ...asActor(actor),
  })) as Pick<Company, 'status'> | null
  return company?.status === 'approved'
}

/** Approve a pending company. It can then send projects for review; it gets an email. */
export const approveCompany: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const company = (await load(payload, actor, 'companies', form)) as Company | null
  if (!company) return fail('not_found')
  if (company.status !== 'pending') return fail('not_allowed')
  return save(payload, actor, 'companies', company.id, { status: 'approved' })
}

/** Reject a pending company, with the reason. It may correct and send its details once. */
export const rejectCompany: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = noteOf(form)
  if ('error' in note) return fail(note.error)
  const company = (await load(payload, actor, 'companies', form)) as Company | null
  if (!company) return fail('not_found')
  if (company.status !== 'pending') return fail('not_allowed')
  return save(
    payload,
    actor,
    'companies',
    company.id,
    { status: 'rejected', noteToCompany: note.note },
    note.note,
  )
}

/** Ask a pending company for more information. It stays pending until it saves its details. */
export const askCompanyInfo: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = noteOf(form)
  if ('error' in note) return fail(note.error)
  const company = (await load(payload, actor, 'companies', form)) as Company | null
  if (!company) return fail('not_found')
  if (company.status !== 'pending' || company.infoRequestedAt) return fail('not_allowed')
  return save(payload, actor, 'companies', company.id, {
    infoRequestedAt: new Date().toISOString(),
    noteToCompany: note.note,
  })
}

/**
 * Approve a submitted project: Konnected's final paid or unpaid decision and, for a paid project,
 * the fixed price in whole kroner excluding VAT. The Projects hook checks both again.
 */
export const approveProject: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const pay = text(form, 'pay')
  if (pay !== 'paid' && pay !== 'unpaid') return fail('pay_choice')
  let fee: number | null = null
  if (pay === 'paid') {
    const typed = text(form, 'price')
    if (!typed) return fail('price_required')
    const price = parsePrice(typed)
    if (price === undefined) return fail('price_invalid')
    fee = price
  }
  const project = (await load(payload, actor, 'projects', form)) as Project | null
  if (!project) return fail('not_found')
  if (project.status !== 'submitted') return fail('not_allowed')
  if (!(await companyApproved(payload, actor, project))) return fail('company_not_approved')
  return save(payload, actor, 'projects', project.id, {
    status: 'approved',
    paidOrUnpaid: pay,
    fee,
    // The note asked for changes before; the approval closes it.
    noteToCompany: null,
  })
}

/** Send a submitted project back to the company with what to change. */
export const requestProjectChanges: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = noteOf(form)
  if ('error' in note) return fail(note.error)
  const project = (await load(payload, actor, 'projects', form)) as Project | null
  if (!project) return fail('not_found')
  if (project.status !== 'submitted') return fail('not_allowed')
  return save(
    payload,
    actor,
    'projects',
    project.id,
    { status: 'changes_requested', noteToCompany: note.note },
    note.note,
  )
}

/** Reject a submitted project, with the reason the company gets. */
export const rejectProject: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = noteOf(form)
  if ('error' in note) return fail(note.error)
  const project = (await load(payload, actor, 'projects', form)) as Project | null
  if (!project) return fail('not_found')
  if (project.status !== 'submitted') return fail('not_allowed')
  return save(
    payload,
    actor,
    'projects',
    project.id,
    { status: 'rejected', noteToCompany: note.note },
    note.note,
  )
}

/**
 * Publish an approved project: students can apply from now on. The rules for publishing live in
 * one place, `assertCanPublish` (src/lib/projects/publish.ts), which the Projects hook runs for
 * every API; the agreements card extends it.
 */
export const publishProject: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const project = (await load(payload, actor, 'projects', form)) as Project | null
  if (!project) return fail('not_found')
  if (project.status !== 'approved') return fail('not_allowed')
  if (!(await companyApproved(payload, actor, project))) return fail('company_not_approved')
  return save(payload, actor, 'projects', project.id, { status: 'published' })
}

/**
 * Mark a profile reviewed (or reviewed again after the student changed it). The hook keeps a copy
 * of what was reviewed, sets the date and emails the student.
 */
export const markProfileReviewed: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const profile = (await load(payload, actor, 'student-profiles', form)) as StudentProfile | null
  if (!profile) return fail('not_found')
  const status = profile.reviewStatus ?? 'waiting'
  if (status === 'reviewed' && !profile.changedSinceReviewAt) return fail('not_allowed')
  return save(payload, actor, 'student-profiles', profile.id, {
    reviewStatus: 'reviewed',
    reviewedAt: new Date().toISOString(),
  })
}

/** Ask the student to change their profile, with a note they read and get by email. */
export const askProfileChanges: Decision = async (payload, actor, form) => {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const note = noteOf(form)
  if ('error' in note) return fail(note.error)
  const profile = (await load(payload, actor, 'student-profiles', form)) as StudentProfile | null
  if (!profile) return fail('not_found')
  if (profile.reviewStatus === 'changes_requested') return fail('not_allowed')
  return save(
    payload,
    actor,
    'student-profiles',
    profile.id,
    { reviewStatus: 'changes_requested', reviewNote: note.note },
    note.note,
  )
}
