import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import type { Question } from '@/payload-types'

import { companyProjectLink } from './projectEmails'
import { type EmailType, sendEmail } from './send'
import { emailLocale, type EmailLocale, questionAnswerEmail, questionRelayEmail } from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * The Ask Konnected emails, in the recipient's saved language, sent after the response:
 * - the team's answer, to the person who asked (their question and the answer);
 * - a question the team passes on, to the other side (the team's own words).
 *
 * Bypass: the server reads the recipient's address and language and the project's title with
 * `overrideAccess: true`. Only the email type and the user id are logged, never the text.
 */

async function recipientOf(req: PayloadRequest, userId: number | undefined) {
  if (!userId) return null
  const user = await req.payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    select: { email: true, language: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!user?.email) return null
  return { id: user.id, email: user.email, locale: emailLocale(user.language) }
}

/** Where the recipient finds the question: the student's application, the company's project. */
export function questionLink(
  locale: EmailLocale,
  q: Pick<Question, 'side' | 'project' | 'application'>,
): string {
  const applicationId = relationId(q.application as Rel)
  if (q.side === 'student') {
    return applicationId
      ? `${appUrl()}/${locale}/student/applications/${applicationId}`
      : `${appUrl()}/${locale}/student/applications`
  }
  return companyProjectLink(locale, relationId(q.project as Rel)!)
}

async function send(
  req: PayloadRequest,
  q: Question,
  type: EmailType,
  render: typeof questionAnswerEmail,
) {
  const to = await recipientOf(req, relationId(q.recipient as Rel))
  const project = await req.payload.findByID({
    collection: 'projects',
    id: relationId(q.project as Rel)!,
    depth: 0,
    select: { title: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!to || !project) return
  await sendEmail(req.payload, {
    to: to.email,
    email: render(to.locale, {
      title: project.title,
      question: q.body,
      answer: q.answer,
      name: q.answeredByName,
      href: questionLink(to.locale, q),
    }),
    type,
    userId: to.id,
  })
}

/** Konnected's answer, to the person who asked. */
export const sendAnswerEmail = (req: PayloadRequest, q: Question): Promise<void> =>
  send(req, q, 'question_answered', questionAnswerEmail)

/** A question the team passes on, to the other side. */
export const sendRelayEmail = (req: PayloadRequest, q: Question): Promise<void> =>
  send(req, q, 'question_relayed', questionRelayEmail)
