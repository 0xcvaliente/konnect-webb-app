import type { Payload, PayloadRequest } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { relationId } from '@/access/roles'
import { emailLocale, type EmailLocale } from '@/lib/email/templates'
import { storedToDay } from '@/lib/projects/fields'
import type { TeamMember as TeamMemberRow, User } from '@/payload-types'

/**
 * Who on the Konnected team gets the team's emails: a user with the admin role, not paused, whose
 * address is on ADMIN_EMAILS (the same people the Team page lists). The morning email and the
 * "problem reported" email both pick their recipients here.
 *
 * Bypass: a background job or a student's report has no team member signed in, so the server
 * reads the team's own user records (role, address, language) and away days with
 * `overrideAccess: true`. Nothing here is logged.
 */

/** The team's user records, by id. */
export async function activeTeamUsers(payload: Payload, req?: PayloadRequest): Promise<User[]> {
  const users = await payload.find({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { accountStatus: { not_equals: 'paused' } }] },
    depth: 0,
    pagination: false,
    sort: 'id',
    overrideAccess: true,
    ...(req ? { req } : {}),
  })
  return (users.docs as User[]).filter((u) => isAdminEmail(u.email))
}

export type TeamRecipient = {
  id: number
  email: string
  locale: EmailLocale
  /** Away days (`YYYY-MM-DD`) and who covers, or null. */
  away: { from: string; until: string; coverId: number | null } | null
}

/** Every team member with their address, language and away days. */
export async function teamRecipients(req: PayloadRequest): Promise<TeamRecipient[]> {
  const team = await activeTeamUsers(req.payload, req)
  if (!team.length) return []
  const rows = await req.payload.find({
    collection: 'team-members',
    where: { user: { in: team.map((u) => u.id) } },
    depth: 0,
    pagination: false,
    overrideAccess: true,
    req,
  })
  const rowOf = new Map(
    (rows.docs as TeamMemberRow[]).map((r) => [relationId(r.user as number), r]),
  )
  return team.map((u) => {
    const row = rowOf.get(u.id)
    const from = storedToDay(row?.awayFrom)
    const until = storedToDay(row?.awayUntil)
    return {
      id: u.id,
      email: u.email,
      locale: emailLocale(u.language),
      away:
        from && until
          ? { from, until, coverId: relationId(row?.coveredBy as number | null) ?? null }
          : null,
    }
  })
}

const awayOn = (member: TeamRecipient, day: string) =>
  Boolean(member.away && member.away.from <= day && day <= member.away.until)

/**
 * Who hears about an item now, the way the morning email routes work: the owner (and, while the
 * owner is away, the team member who covers them); for an item nobody on the team owns (the
 * shared pool), every team member who is not away today, or everyone when all are away.
 */
export function routeToTeam(
  team: TeamRecipient[],
  ownerId: number | null,
  today: string,
): TeamRecipient[] {
  const owner = ownerId ? team.find((m) => m.id === ownerId) : undefined
  if (owner) {
    const cover =
      awayOn(owner, today) && owner.away?.coverId
        ? team.find((m) => m.id === owner.away!.coverId && !awayOn(m, today))
        : undefined
    return cover ? [owner, cover] : [owner]
  }
  const here = team.filter((m) => !awayOn(m, today))
  return here.length ? here : team
}
