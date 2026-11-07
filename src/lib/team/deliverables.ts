import type { Payload } from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import {
  type DeliverableError,
  deliverableErrorCode,
  type DeliverableState,
  type DeliveryItem,
  deliveryState,
  type DeliveryState,
  NOTE_MAX,
} from '@/lib/deliverables/fields'
import { type HandIn, toHandIn } from '@/lib/deliverables/student'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import type { Company, Deliverable, Match, Project, StudentProfile } from '@/payload-types'

import { type ActivityRow, activityOf, type Owner, ownersById, type SessionUser } from './approvals'

/**
 * The team's Deliverables screen (Kanban card "Deliverable submission and handoff", mockup
 * "Deliverables"): hand-ins to check, then release to the company or ask the student for more;
 * released work waiting for the company; work waiting on the student. Every read and write runs
 * through the Local API as the team member with `overrideAccess: false`; the Deliverables hook
 * holds the rules. Nothing here logs notes or names.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

/** check: a hand-in waits for the team. company: released, the company decides. student: the
 * student works on more (Konnected asked) or on the company's fix. */
export type DeliverableSection = 'check' | 'company' | 'student'

export type DeliverableItem = {
  /** The hand-in the item opens. */
  id: number
  matchId: number
  title: string
  companyName: string | null
  studentName: string
  owner: Owner
  section: DeliverableSection
  /** When the item started waiting (ISO). */
  since: string
  /** For released work: the last day the company may ask for fixes (Oslo). */
  fixUntil: string | null
  /** The student is working on the company's fix (not on more Konnected asked for). */
  fix: boolean
}

type Row = Pick<
  Deliverable,
  | 'id'
  | 'match'
  | 'status'
  | 'createdAt'
  | 'submittedAt'
  | 'releasedAt'
  | 'returnedAt'
  | 'fixRequestedAt'
>

const SECTION_ORDER: Record<DeliverableSection, number> = { check: 0, student: 1, company: 2 }

/**
 * The open work on every match: one item per match that waits for someone. Accepted work, and
 * released work whose 7 days are over, is done and not listed. `mine` keeps the actor's companies
 * (ownership routes the work; it never limits access).
 */
export async function listDeliverableQueue(
  payload: Payload,
  actor: SessionUser | null,
  { mine = false }: { mine?: boolean } = {},
): Promise<DeliverableItem[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const found = await payload.find({
    collection: 'deliverables',
    where: { status: { in: ['submitted', 'returned', 'released', 'fix_requested'] } },
    depth: 0,
    pagination: false,
    select: {
      match: true,
      status: true,
      createdAt: true,
      submittedAt: true,
      releasedAt: true,
      returnedAt: true,
      fixRequestedAt: true,
    },
    ...asActor(actor),
  })
  const byMatch = new Map<number, Row[]>()
  for (const row of found.docs as Row[]) {
    const id = relationId(row.match as number)
    if (!id) continue
    byMatch.set(id, [...(byMatch.get(id) ?? []), row])
  }
  if (!byMatch.size) return []

  // Accepted hand-ins count too (a fix round after acceptance does not exist, but the newest
  // release decides), so read every hand-in of these matches.
  const all = await payload.find({
    collection: 'deliverables',
    where: { match: { in: [...byMatch.keys()] } },
    depth: 0,
    pagination: false,
    select: {
      match: true,
      status: true,
      createdAt: true,
      submittedAt: true,
      releasedAt: true,
      returnedAt: true,
      fixRequestedAt: true,
    },
    ...asActor(actor),
  })
  const rowsOf = new Map<number, Row[]>()
  for (const row of all.docs as Row[]) {
    const id = relationId(row.match as number)!
    rowsOf.set(id, [...(rowsOf.get(id) ?? []), row])
  }

  const facts = await matchFacts(payload, actor, [...byMatch.keys()])
  const items: DeliverableItem[] = []
  for (const [matchId, rows] of rowsOf) {
    const fact = facts.get(matchId)
    if (!fact) continue
    const state = deliveryState(rows as DeliveryItem[], fact.projectStatus)
    const base = {
      matchId,
      title: fact.title,
      companyName: fact.companyName,
      studentName: fact.studentName,
      owner: fact.owner,
      fixUntil: null,
      fix: false,
    }
    if (state.waiting) {
      const w = rows.find((r) => r.id === state.waiting!.id)!
      items.push({ ...base, id: w.id, section: 'check', since: w.submittedAt ?? w.createdAt })
      continue
    }
    if (state.fixOpen && state.current) {
      const c = rows.find((r) => r.id === state.current!.id)!
      // The newest hand-in the team returned during the fix round, if any, is what the student
      // works on; otherwise the fix itself.
      items.push({
        ...base,
        id: c.id,
        section: 'student',
        since: c.fixRequestedAt ?? c.createdAt,
        fix: true,
      })
      continue
    }
    if (state.current?.status === 'released' && !state.accepted) {
      const c = rows.find((r) => r.id === state.current!.id)!
      items.push({
        ...base,
        id: c.id,
        section: 'company',
        since: c.releasedAt ?? c.createdAt,
        // Only while the company may still ask for its one round of fixes.
        fixUntil: state.fixUntil,
      })
      continue
    }
    if (!state.current) {
      const returned = rows
        .filter((r) => r.status === 'returned')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (returned) {
        items.push({
          ...base,
          id: returned.id,
          section: 'student',
          since: returned.returnedAt ?? returned.createdAt,
        })
      }
    }
  }
  return items
    .filter((item) => !mine || item.owner?.id === actor.id)
    .sort(
      (a, b) =>
        SECTION_ORDER[a.section] - SECTION_ORDER[b.section] ||
        a.since.localeCompare(b.since) ||
        a.id - b.id,
    )
}

/** Hand-ins waiting for the team, for the menu. */
export async function deliverablesCount(
  payload: Payload,
  actor: SessionUser | null,
): Promise<number> {
  return ((await listDeliverableQueue(payload, actor)) ?? []).filter((i) => i.section === 'check')
    .length
}

type MatchFact = {
  projectId: number
  projectStatus: Project['status'] | null
  title: string
  companyName: string | null
  studentName: string
  owner: Owner
}

/** Project, company owner and student name for each match, read as the team member. */
async function matchFacts(
  payload: Payload,
  actor: SessionUser,
  matchIds: number[],
): Promise<Map<number, MatchFact>> {
  // Work on a match Konnected ended stays with Konnected: it waits for nobody, so it is not listed.
  const matches = await payload.find({
    collection: 'matches',
    where: { and: [{ id: { in: matchIds } }, ACTIVE_MATCH] },
    depth: 0,
    pagination: false,
    select: { project: true, student: true },
    ...asActor(actor),
  })
  const projectIds = [...new Set(matches.docs.map((m) => relationId(m.project as number)!))]
  const studentIds = [...new Set(matches.docs.map((m) => relationId(m.student as number)!))]
  const [projects, profiles] = await Promise.all([
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
  const projectOf = new Map(projects.docs.map((p) => [p.id, p]))
  const nameOf = new Map(profiles.docs.map((p) => [p.id, p.name]))

  const out = new Map<number, MatchFact>()
  for (const m of matches.docs) {
    const project = projectOf.get(relationId(m.project as number)!)
    if (!project) continue
    out.set(m.id, {
      projectId: project.id,
      projectStatus: project.status,
      title: project.title,
      companyName: project.companyName ?? null,
      studentName: nameOf.get(relationId(m.student as number)!) ?? '',
      owner: owners.get(ownerOf.get(relationId(project.company as number) ?? 0) ?? 0) ?? null,
    })
  }
  return out
}

// ---------- One hand-in ----------

export type TeamDeliverable = {
  handIn: HandIn
  matchId: number
  project: Pick<Project, 'id' | 'title' | 'deliverable' | 'paidOrUnpaid' | 'status'> & {
    companyName: string | null
  }
  studentName: string
  owner: Owner
  /** Every hand-in on the match, newest first (this one included). */
  history: HandIn[]
  state: DeliveryState
  activity: ActivityRow[]
}

export async function loadTeamDeliverable(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<TeamDeliverable | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const doc = (await payload.findByID({
    collection: 'deliverables',
    id,
    depth: 1,
    disableErrors: true,
    ...asActor(actor),
  })) as Deliverable | null
  if (!doc) return null
  const matchId = relationId(doc.match as number | Match)!
  const match = (await payload.findByID({
    collection: 'matches',
    id: matchId,
    depth: 0,
    disableErrors: true,
    ...asActor(actor),
  })) as Match | null
  if (!match) return null
  const [project, profile, all, activity] = await Promise.all([
    payload.findByID({
      collection: 'projects',
      id: relationId(match.project as number)!,
      depth: 1,
      ...asActor(actor),
    }) as Promise<Project>,
    payload.findByID({
      collection: 'student-profiles',
      id: relationId(match.student as number)!,
      depth: 0,
      select: { name: true },
      disableErrors: true,
      ...asActor(actor),
    }) as Promise<Pick<StudentProfile, 'id' | 'name'> | null>,
    payload.find({
      collection: 'deliverables',
      where: { match: { equals: matchId } },
      depth: 1,
      pagination: false,
      sort: '-createdAt',
      ...asActor(actor),
    }),
    activityOf(payload, actor, 'deliverables', id),
  ])
  const company = typeof project.company === 'object' ? (project.company as Company) : null
  const owners = await ownersById(payload, actor, [relationId(company?.teamOwner as number)])
  const history = all.docs.map((d) => toHandIn(d as Deliverable))
  return {
    handIn: toHandIn(doc),
    matchId,
    project: {
      id: project.id,
      title: project.title,
      deliverable: project.deliverable,
      paidOrUnpaid: project.paidOrUnpaid,
      status: project.status,
      companyName: project.companyName ?? null,
    },
    studentName: profile?.name ?? '',
    owner: owners.get(relationId(company?.teamOwner as number) ?? 0) ?? null,
    history,
    state: deliveryState(
      history.map((h) => ({
        id: h.id,
        status: h.status,
        createdAt: h.createdAt,
        releasedAt: h.releasedAt,
        fixRequestedAt: h.fixRequestedAt,
      })),
      project.status,
    ),
    activity,
  }
}

// ---------- Decisions ----------

const fail = (error: DeliverableError): DeliverableState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

async function decide(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
  to: 'released' | 'returned',
): Promise<DeliverableState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const raw = form.get('id')
  const id = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
  if (!id) return fail('not_found')
  let returnNote: string | undefined
  if (to === 'returned') {
    const note = form.get('returnNote')
    returnNote = typeof note === 'string' ? note.trim() : ''
    if (!returnNote) return fail('note_required')
    if (returnNote.length > NOTE_MAX) return fail('note_too_long')
  }
  try {
    await payload.update({
      collection: 'deliverables',
      id,
      data: to === 'released' ? { status: 'released' } : { status: 'returned', returnNote },
      // The team's words go on the activity row too, so the history says what was asked.
      context: returnNote ? { activityNote: returnNote } : undefined,
      ...asActor(actor),
    })
    return { status: 'done', doneAt: Date.now() }
  } catch (error) {
    const code = deliverableErrorCode(error)
    if (code) return fail(code)
    const status = statusOf(error)
    if (status === 400 || status === 409) return fail('not_open')
    if (status === 403) return fail('forbidden')
    if (status === 404) return fail('not_found')
    return fail('generic')
  }
}

export const releaseDeliverable = (payload: Payload, actor: SessionUser | null, form: FormData) =>
  decide(payload, actor, form, 'released')

export const returnDeliverable = (payload: Payload, actor: SessionUser | null, form: FormData) =>
  decide(payload, actor, form, 'returned')
