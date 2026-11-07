import type { Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { storedToDay } from '@/lib/projects/fields'
import { DECISION_DAYS } from '@/lib/applications/fields'
import { PROFILE_REVIEW_DAYS } from '@/lib/students/fields'
import { osloDay, type PromiseState, promiseState, workingDaysBetween } from '@/lib/workingDays'
import type { Agreement, Deliverable, Match, Project } from '@/payload-types'

import { isOpen, listQueue, type QueueItem, type SessionUser } from './approvals'
import { listDeliverableQueue } from './deliverables'
import { listMatchingQueue } from './matching'
import { POOL_AMBER_DAYS, type PoolCollection } from './memberFields'
import { listTeam, type TeamMember } from './members'
import { listPaymentLog } from './payments'
import { listOpenProblems, listProjectsWithoutMatch } from './projects'

/**
 * The team's Today (Kanban cards "Today queue: due soon, overdue, key numbers, questions, data
 * requests" and "Today: My work and Everyone"): every open item that needs the team, each with
 * its owner (or the shared pool) and, where Konnected promises a number of working days, a
 * countdown. Built from the queues themselves, read as the team member with `overrideAccess:
 * false`; ownership only sorts the work into lists, it never hides anything.
 *
 * The same list feeds the morning email (morningEmail.ts), read as each team member.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

export type WorkKind =
  | 'company'
  | 'profile'
  | 'project'
  | 'publish'
  | 'decision'
  | 'agreement'
  | 'deliverable'
  | 'problem'
  | 'noMatch'
  | 'payment'
  | 'workDue'

export type WorkItem = {
  key: string
  kind: WorkKind
  title: string
  /** The company, the school, or the student: whatever tells the item apart. */
  detail: string | null
  href: string
  /** The owner on the team, or null for the shared pool. */
  ownerId: number | null
  /** When the item started waiting (ISO). */
  since: string
  /** The countdown, where a working-day promise (or a due date) applies. */
  due: PromiseState | null
  /** Set while nobody owns the item: it waits in the shared pool for someone to take it. */
  pool: { collection: PoolCollection; id: number; waited: number; amber: boolean } | null
}

export type KeyNumbers = {
  inProgress: number
  waitingForStudent: number
  agreementsOpen: number
  studentsReviewed: number
  activeCompanies: number
  pool: number
}

export type TodayData = {
  /** Today in Oslo, `YYYY-MM-DD`. */
  today: string
  team: TeamMember[]
  /** Every open item, most urgent first. */
  items: WorkItem[]
  numbers: KeyNumbers
}

/** Work due within this many working days shows on Today. */
const WORK_DUE_WINDOW = 3

/** Most urgent first: late, then due soonest, then items with a promise, then oldest. */
export function byUrgency(a: WorkItem, b: WorkItem): number {
  const rank = (item: WorkItem) => (item.due ? item.due.left : Number.POSITIVE_INFINITY)
  return rank(a) - rank(b) || a.since.localeCompare(b.since) || a.key.localeCompare(b.key)
}

/** Overdue: a promise or due date has passed. */
export const isOverdue = (item: WorkItem): boolean => item.due?.tone === 'late'
/** Due soon: due today or the next working day. */
export const isDueSoon = (item: WorkItem): boolean => item.due?.tone === 'soon'
/** Due today (for the morning email). */
export const isDueToday = (item: WorkItem): boolean => item.due?.left === 0

/** A plain countdown to a due day: days left, 0 on the day, negative when late. */
function dueOn(dueDay: string, today: string): PromiseState {
  const left =
    today <= dueDay
      ? workingDaysBetween(today, dueDay)
      : -Math.max(1, workingDaysBetween(dueDay, today))
  return { dueDay, left, tone: left < 0 ? 'late' : left <= 1 ? 'soon' : 'ok' }
}

const POOL_OF: Record<'companies' | 'projects' | 'students', PoolCollection> = {
  companies: 'companies',
  projects: 'projects',
  students: 'student-profiles',
}

function approvalItems(
  tab: 'companies' | 'projects' | 'students',
  items: QueueItem[],
  now: Date,
): WorkItem[] {
  const today = osloDay(now)
  return items.filter(isOpen).map((item) => {
    const waited = Math.max(0, workingDaysBetween(osloDay(new Date(item.since)), today))
    const kind: WorkKind =
      tab === 'companies'
        ? 'company'
        : tab === 'students'
          ? 'profile'
          : item.section === 'publish'
            ? 'publish'
            : 'project'
    return {
      key: `${tab}-${item.id}`,
      kind,
      title: item.title,
      detail: item.subtitle,
      href: `/team/approvals?tab=${tab}&item=${item.id}`,
      ownerId: item.owner?.id ?? null,
      since: item.since,
      // The profile review promise, counted to `now` (the morning email looks at a set time).
      due: item.due ? promiseState(new Date(item.since), PROFILE_REVIEW_DAYS, now) : null,
      pool: item.owner
        ? null
        : { collection: POOL_OF[tab], id: item.id, waited, amber: waited >= POOL_AMBER_DAYS },
    }
  })
}

/** Agreements waiting for Konnected's signature, or whose PDF could not be made. */
async function agreementItems(payload: Payload, actor: SessionUser): Promise<WorkItem[]> {
  const found = await payload.find({
    collection: 'agreements',
    where: { status: { in: ['awaiting_konnected', 'failed'] } },
    depth: 0,
    pagination: false,
    select: { title: true, status: true, project: true, updatedAt: true },
    ...asActor(actor),
  })
  if (!found.docs.length) return []
  const projectIds = [
    ...new Set(found.docs.map((a) => relationId(a.project as number)).filter(Boolean)),
  ] as number[]
  const projects = await payload.find({
    collection: 'projects',
    where: { id: { in: projectIds } },
    depth: 0,
    pagination: false,
    select: { owner: true, companyName: true },
    ...asActor(actor),
  })
  const projectOf = new Map(projects.docs.map((p) => [p.id, p]))
  return (found.docs as Agreement[]).map((a) => {
    const project = projectOf.get(relationId(a.project as number) ?? 0)
    return {
      key: `agreement-${a.id}`,
      kind: 'agreement' as const,
      title: a.title ?? '',
      detail: project?.companyName ?? null,
      href: `/team/agreements/${a.id}`,
      ownerId: relationId(project?.owner as number) ?? null,
      since: a.updatedAt,
      due: null,
      pool: null,
    }
  })
}

/**
 * Running projects whose work is due within a few working days, or overdue, and not handed in
 * yet: the owner follows them up with the student.
 */
async function workDueItems(
  payload: Payload,
  actor: SessionUser,
  today: string,
): Promise<WorkItem[]> {
  const matches = await payload.find({
    collection: 'matches',
    where: { and: [ACTIVE_MATCH, { endDate: { exists: true } }] },
    depth: 0,
    pagination: false,
    select: { project: true, endDate: true, updatedAt: true },
    ...asActor(actor),
  })
  const soon = (matches.docs as Match[])
    .map((m) => ({ m, dueDay: storedToDay(m.endDate) }))
    .filter(
      (x): x is { m: Match; dueDay: string } =>
        Boolean(x.dueDay) && dueOn(x.dueDay!, today).left <= WORK_DUE_WINDOW,
    )
  if (!soon.length) return []
  const [projects, handedIn] = await Promise.all([
    payload.find({
      collection: 'projects',
      where: {
        and: [
          { id: { in: soon.map((x) => relationId(x.m.project as number)!) } },
          { status: { equals: 'in_progress' } },
        ],
      },
      depth: 0,
      pagination: false,
      select: { title: true, companyName: true, owner: true },
      ...asActor(actor),
    }),
    payload.find({
      collection: 'deliverables',
      where: {
        and: [
          { match: { in: soon.map((x) => x.m.id) } },
          { status: { in: ['submitted', 'released', 'accepted'] } },
        ],
      },
      depth: 0,
      pagination: false,
      select: { match: true },
      ...asActor(actor),
    }),
  ])
  const projectOf = new Map(projects.docs.map((p) => [p.id, p as Project]))
  const done = new Set((handedIn.docs as Deliverable[]).map((d) => relationId(d.match as number)))
  return soon.flatMap(({ m, dueDay }) => {
    const project = projectOf.get(relationId(m.project as number) ?? 0)
    if (!project || done.has(m.id)) return []
    return [
      {
        key: `work-${m.id}`,
        kind: 'workDue' as const,
        title: project.title,
        detail: project.companyName ?? null,
        href: `/team/projects/${project.id}`,
        ownerId: relationId(project.owner as number) ?? null,
        since: m.updatedAt,
        due: dueOn(dueDay, today),
        pool: null,
      },
    ]
  })
}

async function keyNumbers(payload: Payload, actor: SessionUser, pool: number): Promise<KeyNumbers> {
  const count = async (
    collection: 'projects' | 'agreements' | 'student-profiles' | 'companies',
    where: Parameters<Payload['count']>[0]['where'],
  ) => (await payload.count({ collection, where, ...asActor(actor) })).totalDocs
  const [inProgress, waitingForStudent, agreementsOpen, studentsReviewed, activeCompanies] =
    await Promise.all([
      count('projects', { status: { in: ['matched', 'in_progress'] } }),
      count('projects', { status: { equals: 'published' } }),
      count('agreements', {
        status: { in: ['generating', 'awaiting_party', 'awaiting_konnected', 'failed'] },
      }),
      count('student-profiles', { reviewStatus: { equals: 'reviewed' } }),
      count('companies', { status: { equals: 'approved' } }),
    ])
  return { inProgress, waitingForStudent, agreementsOpen, studentsReviewed, activeCompanies, pool }
}

/** Everything Today shows, read as the team member. Null for anyone not on the team. */
export async function loadToday(
  payload: Payload,
  actor: SessionUser | null,
  now: Date = new Date(),
): Promise<TodayData | null> {
  if (!actor || !isAdmin(actor)) return null
  const today = osloDay(now)
  const [team, companies, projects, students, matching, agreements, deliverables, problems] =
    await Promise.all([
      listTeam(payload, actor),
      listQueue(payload, actor, 'companies'),
      listQueue(payload, actor, 'projects'),
      listQueue(payload, actor, 'students'),
      listMatchingQueue(payload, actor),
      agreementItems(payload, actor),
      listDeliverableQueue(payload, actor),
      listOpenProblems(payload, actor),
    ])
  const [noMatch, payments, workDue] = await Promise.all([
    listProjectsWithoutMatch(payload, actor),
    listPaymentLog(payload, actor, { filter: 'action' }),
    workDueItems(payload, actor, today),
  ])

  const items: WorkItem[] = [
    ...approvalItems('companies', companies ?? [], now),
    ...approvalItems('projects', projects ?? [], now),
    ...approvalItems('students', students ?? [], now),
    ...(matching ?? [])
      .filter((m) => m.section === 'decide')
      .map((m): WorkItem => ({
        key: `decision-${m.id}`,
        kind: 'decision',
        title: m.title,
        detail: m.companyName,
        href: `/team/matching?project=${m.id}`,
        ownerId: m.owner?.id ?? null,
        since: m.closesOn ? `${m.closesOn}T12:00:00.000Z` : now.toISOString(),
        // The decision promise, counted to `now` (the morning email looks at a set time).
        due: m.closesOn
          ? promiseState(new Date(`${m.closesOn}T12:00:00Z`), DECISION_DAYS, now)
          : m.due,
        pool: null,
      })),
    ...agreements,
    ...(deliverables ?? [])
      .filter((d) => d.section === 'check')
      .map((d): WorkItem => ({
        key: `deliverable-${d.id}`,
        kind: 'deliverable',
        title: d.title,
        detail: d.companyName,
        href: `/team/deliverables?item=${d.id}`,
        ownerId: d.owner?.id ?? null,
        since: d.since,
        due: null,
        pool: null,
      })),
    ...(problems ?? []).map((p): WorkItem => ({
      key: `problem-${p.id}`,
      kind: 'problem',
      title: p.title,
      detail: p.companyName,
      href: `/team/projects/${p.projectId}`,
      ownerId: p.ownerId,
      since: p.since,
      due: null,
      pool: null,
    })),
    ...(noMatch ?? []).map((p): WorkItem => ({
      key: `nomatch-${p.projectId}`,
      kind: 'noMatch',
      title: p.title,
      detail: p.companyName,
      href: `/team/projects/${p.projectId}`,
      ownerId: p.ownerId,
      since: `${p.closedOn}T12:00:00.000Z`,
      due: null,
      pool: null,
    })),
    ...(payments?.rows ?? []).map((r): WorkItem => ({
      key: `payment-${r.id}`,
      kind: 'payment',
      title: r.title,
      detail: r.companyName,
      href: `/team/payments?row=${r.id}`,
      ownerId: r.owner?.id ?? null,
      since: r.releasedAt ?? r.version,
      due: null,
      pool: null,
    })),
    ...workDue,
  ].sort(byUrgency)

  const pool = items.filter((i) => i.pool).length
  return {
    today,
    team: team ?? [],
    items,
    numbers: await keyNumbers(payload, actor, pool),
  }
}

/** The items whose owner is one of `ids` (a member, plus anyone they cover today). */
export const itemsOf = (items: WorkItem[], ids: Set<number>): WorkItem[] =>
  items.filter((i) => i.ownerId !== null && ids.has(i.ownerId))

/** The items waiting in the shared pool, oldest first. */
export const poolItems = (items: WorkItem[]): WorkItem[] =>
  items.filter((i) => i.pool).sort((a, b) => a.since.localeCompare(b.since))
