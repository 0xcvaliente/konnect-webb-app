import type { Payload } from 'payload'

import { appUrl } from '@/lib/auth/env'
import { sendEmail } from '@/lib/email/send'
import { type MorningLine, teamMorningEmail } from '@/lib/email/templates'
import en from '@/messages/en.json'
import no from '@/messages/no.json'
import { isWorkingDay, osloDay } from '@/lib/workingDays'

import type { SessionUser } from './approvals'
import { MORNING_EMAIL_AT } from './memberFields'
import { coveredBy, firstName, isAwayOn } from './members'
import { activeTeamUsers } from './recipients'
import { isDueToday, isOverdue, itemsOf, loadToday, poolItems, type WorkItem } from './today'

/**
 * The team's morning email (Kanban card "Today: My work and Everyone, plus a personal morning
 * email"): on working days from 07:30 in Oslo, each team member gets one email with their items
 * due today and overdue, those of anyone they cover, and how long the shared pool has waited.
 * In the member's language. A member who is away gets none; a day never gets two (the day is
 * kept on the member's `team-members` row). Nothing to tell means no email.
 *
 * The job runs every 15 minutes (see jobs/morningEmail.ts) and does nothing outside the window,
 * so it does not depend on the server's time zone. The lists are read as each team member with
 * access control on, the same as their Today page. Only counts are logged.
 */

/** Send no morning email after this hour (Oslo): a late start should not mail at night. */
const LATEST_HOUR = 12

const KINDS = { en: en.TeamToday.kind, no: no.TeamToday.kind }

function osloClock(now: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { hour: get('hour'), minute: get('minute') }
}

/** Is it time for the morning email (a working day in Oslo, 07:30 to noon)? */
export function isMorningWindow(now: Date): boolean {
  if (!isWorkingDay(osloDay(now))) return false
  const { hour, minute } = osloClock(now)
  const afterStart =
    hour > MORNING_EMAIL_AT.hour ||
    (hour === MORNING_EMAIL_AT.hour && minute >= MORNING_EMAIL_AT.minute)
  return afterStart && hour < LATEST_HOUR
}

const lineOf = (locale: 'en' | 'no', item: WorkItem): MorningLine => ({
  kind: KINDS[locale][item.kind],
  // Never a student's name in an email: a profile is "a student profile".
  title: item.kind === 'profile' ? null : item.title,
  daysLate: item.due && item.due.left < 0 ? -item.due.left : 0,
})

const pressing = (items: WorkItem[]) => items.filter((i) => isOverdue(i) || isDueToday(i))

/** Send today's morning emails that are due. Returns how many went out. */
export async function sendMorningEmails(payload: Payload, now: Date = new Date()): Promise<number> {
  if (!isMorningWindow(now)) return 0
  const today = osloDay(now)
  // A background job has no signed-in user. It reads who is on the team (recipients.ts, the same
  // people the "problem reported" email goes to), then reads each list as that team member.
  let sent = 0
  for (const user of await activeTeamUsers(payload)) {
    const actor = { ...user, collection: 'users' } as SessionUser
    const data = await loadToday(payload, actor, now)
    if (!data) continue
    const me = data.team.find((m) => m.id === user.id)
    if (!me || me.morningEmailOn === today || isAwayOn(me, today)) continue

    const locale = me.language
    const mine = pressing(itemsOf(data.items, new Set([me.id])))
    const covering = coveredBy(data.team, me.id, today)
      .map((other) => ({
        name: firstName(other.name),
        lines: pressing(itemsOf(data.items, new Set([other.id]))).map((i) => lineOf(locale, i)),
      }))
      .filter((c) => c.lines.length)
    const pool = poolItems(data.items)
    const amberPool = pool.filter((i) => i.pool?.amber || isOverdue(i) || isDueToday(i))

    // Mark the day first, so a retry or a second worker never sends it twice. Bypass: the job
    // writes the server-kept day on the member's own settings row; no log row for it.
    const mark = { morningEmailOn: today }
    if (me.rowId) {
      await payload.update({
        collection: 'team-members',
        id: me.rowId,
        data: mark,
        overrideAccess: true,
        context: { skipActivityLog: true },
      })
    } else {
      await payload.create({
        collection: 'team-members',
        data: { user: me.id, ...mark },
        overrideAccess: true,
        context: { skipActivityLog: true },
      })
    }
    if (!mine.length && !covering.length && !amberPool.length) continue

    await sendEmail(payload, {
      to: user.email,
      email: teamMorningEmail(locale, {
        name: firstName(me.name),
        overdue: mine.filter(isOverdue).map((i) => lineOf(locale, i)),
        dueToday: mine.filter(isDueToday).map((i) => lineOf(locale, i)),
        covering,
        pool: {
          count: pool.length,
          oldestDays: Math.max(0, ...pool.map((i) => i.pool?.waited ?? 0)),
        },
        href: `${appUrl()}/${locale}/team`,
      }),
      type: 'team_morning',
      userId: user.id,
    })
    sent += 1
  }
  return sent
}
