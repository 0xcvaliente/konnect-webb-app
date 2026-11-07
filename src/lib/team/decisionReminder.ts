import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { relationId } from '@/access/roles'
import { decisionDayOf } from '@/lib/applications/fields'
import { appUrl } from '@/lib/auth/env'
import { sendEmail } from '@/lib/email/send'
import { decisionReminderEmail } from '@/lib/email/templates'
import { dayToStored, storedToDay } from '@/lib/projects/fields'
import { osloDay, workingDaysBetween } from '@/lib/workingDays'
import type { Project, User } from '@/payload-types'

import type { SessionUser } from './approvals'
import { isMorningWindow } from './morningEmail'
import { firstName, isAwayOn, listTeam, type TeamMember } from './members'

/**
 * The owner's reminder before a decision is due (Kanban card "Decision dates on applications and
 * projects"): Konnected promises the students who applied a decision within 3 working days after
 * applications close (`projects.decisionBy`). On the working day before that day (or on the day
 * itself, if the job could not run before), in the Oslo morning, the project's owner on the team
 * gets one email: the project, the day, and how many applications wait. An owner who is away today
 * has it sent to whoever covers for them; a project nobody on the team owns has it sent to the
 * whole team (the shared pool). Once per project and decision day (`decisionReminderFor`).
 *
 * Never a student's name or anything about an applicant beyond the count. Only counts are logged.
 */

/** Which day's reminder is due for a decision day: the working day before it, or the day itself. */
export function reminderDue(decisionDay: string, today: string): boolean {
  return today <= decisionDay && workingDaysBetween(today, decisionDay) <= 1
}

/** Who gets the reminder of a project owned by `ownerId` (null: nobody on the team owns it). */
export function recipientsFor(
  team: TeamMember[],
  ownerId: number | null,
  today: string,
): TeamMember[] {
  const owner = ownerId ? team.find((m) => m.id === ownerId) : undefined
  if (!owner) return team.filter((m) => !isAwayOn(m, today))
  if (!isAwayOn(owner, today)) return [owner]
  const cover = owner.away?.coverId ? team.find((m) => m.id === owner.away!.coverId) : undefined
  return cover && !isAwayOn(cover, today) ? [cover] : team.filter((m) => !isAwayOn(m, today))
}

/** Send the decision reminders that are due now. Returns how many emails went out. */
export async function sendDecisionReminders(
  payload: Payload,
  now: Date = new Date(),
): Promise<number> {
  if (!isMorningWindow(now)) return 0
  const today = osloDay(now)
  // Bypass: a background job has no signed-in user. It reads the published projects' decision
  // days, owners and titles, and counts their open applications; only counts leave this module,
  // besides the project title in the team's own email.
  const projects = await payload.find({
    collection: 'projects',
    // Projects saved before `decisionBy` existed count it from the closing day (decisionDayOf).
    where: { status: { equals: 'published' } },
    depth: 0,
    pagination: false,
    select: {
      title: true,
      companyName: true,
      owner: true,
      deadline: true,
      decisionBy: true,
      decisionReminderFor: true,
    },
    overrideAccess: true,
  })
  const due = (projects.docs as Project[]).filter((p) => {
    const day = decisionDayOf(p)
    return day && reminderDue(day, today) && storedToDay(p.decisionReminderFor) !== day
  })
  if (!due.length) return 0

  // The team, read as one of its members (listTeam reads with access control on).
  const admins = await payload.find({
    collection: 'users',
    where: { and: [{ role: { equals: 'admin' } }, { accountStatus: { not_equals: 'paused' } }] },
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  const someone = (admins.docs as User[]).find((u) => isAdminEmail(u.email))
  if (!someone) return 0
  const team = (await listTeam(payload, { ...someone, collection: 'users' } as SessionUser)) ?? []

  let sent = 0
  for (const project of due) {
    const day = decisionDayOf(project)!
    const { totalDocs: waiting } = await payload.count({
      collection: 'applications',
      where: {
        and: [{ project: { equals: project.id } }, { status: { in: ['applied', 'shortlisted'] } }],
      },
      overrideAccess: true,
    })
    // Mark the day first, so a retry or a second worker never sends it twice. Bypass: the job
    // writes the server-kept day; no activity row for it.
    await payload.update({
      collection: 'projects',
      id: project.id,
      data: { decisionReminderFor: dayToStored(day) },
      overrideAccess: true,
      context: { skipActivityLog: true },
    })
    // Nobody waits for a decision (no open application): no reminder. The project shows on
    // Today as a project without a match.
    if (!waiting) continue
    for (const member of recipientsFor(team, relationId(project.owner as number) ?? null, today)) {
      await sendEmail(payload, {
        to: member.email,
        email: decisionReminderEmail(member.language, {
          name: firstName(member.name),
          title: project.title,
          company: project.companyName ?? '',
          decisionDay: day,
          waiting,
          href: `${appUrl()}/${member.language}/team/matching?project=${project.id}`,
        }),
        type: 'decision_reminder',
        userId: member.id,
      })
      sent += 1
    }
  }
  return sent
}
