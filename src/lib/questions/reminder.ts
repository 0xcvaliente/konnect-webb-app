import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { relationId } from '@/access/roles'
import type { QuestionContext } from '@/collections/Questions'
import { appUrl } from '@/lib/auth/env'
import { sendEmail } from '@/lib/email/send'
import { questionReminderEmail } from '@/lib/email/templates'
import type { SessionUser } from '@/lib/team/approvals'
import { recipientsFor, reminderDue } from '@/lib/team/decisionReminder'
import { firstName, listTeam } from '@/lib/team/members'
import { isMorningWindow } from '@/lib/team/morningEmail'
import { addWorkingDays, osloDay } from '@/lib/workingDays'
import type { Project, Question, User } from '@/payload-types'

import { ANSWER_DAYS } from './fields'

/**
 * The owner's reminder before an Ask Konnected answer is due: Konnected promises an answer within
 * 2 working days. On the working day before the last day (or on the day itself, if the job could
 * not run before), in the Oslo morning, the project's owner on the team gets one email per
 * question; an owner who is away has it sent to whoever covers, and a project nobody owns to the
 * whole team (the shared pool). Once per question (`reminderSentAt`).
 *
 * The email says neither who asked nor what. Only counts are logged.
 */

/** The last day of the promise for a question asked at `askedAt`. */
export const answerDueDay = (askedAt: string): string =>
  addWorkingDays(osloDay(new Date(askedAt)), ANSWER_DAYS)

export async function sendQuestionReminders(
  payload: Payload,
  now: Date = new Date(),
): Promise<number> {
  if (!isMorningWindow(now)) return 0
  const today = osloDay(now)
  // Bypass: a background job has no signed-in user. It reads the open questions' dates and
  // projects, and the projects' titles and owners; only the title leaves, in the team's email.
  const open = await payload.find({
    collection: 'questions',
    where: {
      and: [
        { kind: { equals: 'ask' } },
        { status: { equals: 'open' } },
        { reminderSentAt: { exists: false } },
      ],
    },
    depth: 0,
    pagination: false,
    select: { project: true, createdAt: true },
    overrideAccess: true,
  })
  const due = (open.docs as Question[]).filter((q) => reminderDue(answerDueDay(q.createdAt), today))
  if (!due.length) return 0

  const projectIds = [...new Set(due.map((q) => relationId(q.project as number)!))]
  const projects = await payload.find({
    collection: 'projects',
    where: { id: { in: projectIds } },
    depth: 0,
    pagination: false,
    select: { title: true, companyName: true, owner: true },
    overrideAccess: true,
  })
  const projectOf = new Map((projects.docs as Project[]).map((p) => [p.id, p]))

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
  for (const question of due) {
    const project = projectOf.get(relationId(question.project as number)!)
    // Stamp first, so a retry or a second worker never sends it twice. Bypass: the job writes the
    // server-kept stamp only (the hook keeps everything else); no activity row for it.
    await payload.update({
      collection: 'questions',
      id: question.id,
      data: { reminderSentAt: now.toISOString() },
      overrideAccess: true,
      context: { skipActivityLog: true, questionReminder: true } satisfies QuestionContext & {
        skipActivityLog: boolean
      },
    })
    if (!project) continue
    for (const member of recipientsFor(team, relationId(project.owner as number) ?? null, today)) {
      await sendEmail(payload, {
        to: member.email,
        email: questionReminderEmail(member.language, {
          name: firstName(member.name),
          title: project.title,
          company: project.companyName ?? '',
          dueDay: answerDueDay(question.createdAt),
          href: `${appUrl()}/${member.language}/team/questions?item=${question.id}`,
        }),
        type: 'question_reminder',
        userId: member.id,
      })
      sent += 1
    }
  }
  return sent
}
