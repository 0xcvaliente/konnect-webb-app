import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { isAdmin, relationId } from '@/access/roles'
import { dayToStored, parseDay, storedToDay } from '@/lib/projects/fields'
import { osloDay } from '@/lib/workingDays'
import type { TeamMember as TeamMemberRow } from '@/payload-types'

import type { SessionUser } from './approvals'
import { AWAY_MAX_DAYS, type TeamFormState, teamDone, teamFail } from './memberFields'

/**
 * The Konnected team (Kanban cards "Team split" and "Team page: workload, owners and away
 * cover"): who is on it, who is away today and who covers for them. A team member is a user with
 * the admin role whose address is on ADMIN_EMAILS. Plain functions over Payload, read and written
 * as the signed-in team member with `overrideAccess: false`.
 */

const asActor = (actor: SessionUser) => ({ user: actor, overrideAccess: false as const })

export type Away = { from: string; until: string; coverId: number | null }

export type TeamMember = {
  id: number
  name: string
  email: string
  language: 'en' | 'no'
  /** The away days set for this member (past, current or coming), or null. */
  away: Away | null
  /** The member's `team-members` row, once one exists. */
  rowId: number | null
  morningEmailOn: string | null
}

/** Is the member away on this Oslo day? */
export const isAwayOn = (member: Pick<TeamMember, 'away'>, day: string): boolean =>
  Boolean(member.away && member.away.from <= day && day <= member.away.until)

/** The members away on `day` whose cover is `memberId`. */
export const coveredBy = (team: TeamMember[], memberId: number, day: string): TeamMember[] =>
  team.filter((m) => m.id !== memberId && isAwayOn(m, day) && m.away?.coverId === memberId)

/** Whose items count as "mine" for a member today: their own and those of anyone they cover. */
export const mineIds = (team: TeamMember[], memberId: number, day: string): Set<number> =>
  new Set([memberId, ...coveredBy(team, memberId, day).map((m) => m.id)])

/** First name for short labels ("Covering for Julie"). */
export const firstName = (name: string): string => name.split(/[\s@]/)[0] || name

/** Every team member, by name. Null for anyone not on the team. */
export async function listTeam(
  payload: Payload,
  actor: SessionUser | null,
): Promise<TeamMember[] | null> {
  if (!actor || !isAdmin(actor)) return null
  const users = await payload.find({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { accountStatus: { not_equals: 'paused' } }] },
    depth: 0,
    pagination: false,
    select: { name: true, email: true, language: true },
    ...asActor(actor),
  })
  const team = users.docs.filter((u) => isAdminEmail(u.email))
  if (!team.length) return []
  const rows = await payload.find({
    collection: 'team-members',
    where: { user: { in: team.map((u) => u.id) } },
    depth: 0,
    pagination: false,
    ...asActor(actor),
  })
  const rowOf = new Map(
    (rows.docs as TeamMemberRow[]).map((r) => [relationId(r.user as number), r]),
  )
  return team
    .map((u): TeamMember => {
      const row = rowOf.get(u.id)
      const from = storedToDay(row?.awayFrom)
      const until = storedToDay(row?.awayUntil)
      return {
        id: u.id,
        name: u.name || u.email,
        email: u.email,
        language: u.language === 'no' ? 'no' : 'en',
        away:
          from && until
            ? { from, until, coverId: relationId(row?.coveredBy as number | null) ?? null }
            : null,
        rowId: row?.id ?? null,
        morningEmailOn: row?.morningEmailOn ?? null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const idFrom = (form: FormData, name: string): number | undefined => {
  const id = Number(text(form, name))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/**
 * Save a member's away days and cover (form: `memberId`, `from`, `until`, `coverId`), or clear
 * them (`clear` set). Any team member may set them for any member. The collection hook checks
 * the dates and the cover again, and logs the change.
 */
export async function saveAway(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
  now: Date = new Date(),
): Promise<TeamFormState> {
  if (!actor || !isAdmin(actor)) return teamFail('notFound')
  const team = (await listTeam(payload, actor)) ?? []
  const member = team.find((m) => m.id === idFrom(form, 'memberId'))
  if (!member) return teamFail('notFound')
  const clear = text(form, 'clear') === '1'
  let data: Record<string, unknown>
  if (clear) {
    data = { awayFrom: null, awayUntil: null, coveredBy: null }
  } else {
    const from = parseDay(text(form, 'from'))
    const until = parseDay(text(form, 'until'))
    const today = osloDay(now)
    if (!from || !until || until < from || until < today) return teamFail('dates')
    const longest = new Date(`${from}T12:00:00Z`)
    longest.setUTCDate(longest.getUTCDate() + AWAY_MAX_DAYS)
    if (until > longest.toISOString().slice(0, 10)) return teamFail('dates')
    const coverId = idFrom(form, 'coverId')
    if (!coverId || coverId === member.id || !team.some((m) => m.id === coverId)) {
      return teamFail('cover')
    }
    data = { awayFrom: dayToStored(from), awayUntil: dayToStored(until), coveredBy: coverId }
  }
  try {
    if (member.rowId) {
      await payload.update({
        collection: 'team-members',
        id: member.rowId,
        data,
        ...asActor(actor),
      })
    } else {
      await payload.create({
        collection: 'team-members',
        data: { user: member.id, ...data },
        ...asActor(actor),
      })
    }
    return teamDone()
  } catch {
    return teamFail('failed')
  }
}

/** Project statuses that count as active work for an owner. */
export const ACTIVE_PROJECT: string[] = ['published', 'matched', 'in_progress']

export type CompanyOwnerRow = {
  id: number
  name: string
  status: string
  ownerId: number | null
  /** Projects in ACTIVE_PROJECT. */
  active: number
}

export type TeamOverview = {
  companies: CompanyOwnerRow[]
  /** Active projects per owner (by the project's own owner). */
  activeByOwner: Map<number, number>
}

/** Companies (approved or waiting) with their owner and active projects, for the Team page. */
export async function loadTeamOverview(
  payload: Payload,
  actor: SessionUser | null,
): Promise<TeamOverview | null> {
  if (!actor || !isAdmin(actor)) return null
  const [companies, projects] = await Promise.all([
    payload.find({
      collection: 'companies',
      where: { status: { in: ['approved', 'pending'] } },
      depth: 0,
      pagination: false,
      sort: 'name',
      select: { name: true, status: true, teamOwner: true, takenBy: true },
      ...asActor(actor),
    }),
    payload.find({
      collection: 'projects',
      where: { status: { in: ACTIVE_PROJECT } },
      depth: 0,
      pagination: false,
      select: { company: true, owner: true },
      ...asActor(actor),
    }),
  ])
  const perCompany = new Map<number, number>()
  const activeByOwner = new Map<number, number>()
  for (const p of projects.docs) {
    const company = relationId(p.company as number)
    if (company) perCompany.set(company, (perCompany.get(company) ?? 0) + 1)
    const owner = relationId(p.owner as number)
    if (owner) activeByOwner.set(owner, (activeByOwner.get(owner) ?? 0) + 1)
  }
  return {
    companies: companies.docs.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      ownerId: relationId(c.teamOwner as number) ?? relationId(c.takenBy as number) ?? null,
      active: perCompany.get(c.id) ?? 0,
    })),
    activeByOwner,
  }
}

/**
 * The owners whose items are "mine" for the Mine / Everyone switch in every queue: the member's
 * own, and those of anyone they cover today.
 */
export async function myOwnerIds(payload: Payload, actor: SessionUser): Promise<Set<number>> {
  const team = (await listTeam(payload, actor)) ?? []
  return mineIds(team, actor.id, osloDay(new Date()))
}
