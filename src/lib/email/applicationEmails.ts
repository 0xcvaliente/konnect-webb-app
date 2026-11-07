import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { decisionDay } from '@/lib/applications/fields'
import { appUrl } from '@/lib/auth/env'
import { storedToDay } from '@/lib/projects/fields'
import type { Application } from '@/payload-types'

import { sendEmail } from './send'
import { applicationReceivedEmail, emailLocale } from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * Tell the student that Konnected received their application, in their saved language, with a
 * link to the application and the day Konnected decides by. Called from the Applications
 * afterChange hook; sent after the response, so a slow mail server never fails the application.
 *
 * Bypass: the server reads the application's team-only marker, the profile's user (address and
 * language) and the project's title and closing day with `overrideAccess: true`. Nothing about the student goes anywhere but to the
 * student's own address, and only the email type and user id are logged.
 */
export async function sendApplicationReceivedEmail(
  req: PayloadRequest,
  application: Pick<Application, 'id' | 'student' | 'project'>,
): Promise<void> {
  // The team-only marker is not in the student's copy of the document: read it from the database.
  const stored = await req.payload.findByID({
    collection: 'applications',
    id: application.id,
    depth: 0,
    select: { profileWaiting: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const profileId = relationId(application.student as Rel)
  const projectId = relationId(application.project as Rel)
  if (!profileId || !projectId) return
  const profile = await req.payload.findByID({
    collection: 'student-profiles',
    id: profileId,
    depth: 0,
    select: { user: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const userId = relationId(profile?.user as Rel)
  if (!userId) return
  // One after the other: both join the request's transaction.
  const user = await req.payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    select: { email: true, language: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, deadline: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!user?.email || !project) return
  const locale = emailLocale(user.language)
  await sendEmail(req.payload, {
    to: user.email,
    email: applicationReceivedEmail(locale, {
      title: project.title,
      decideBy: decisionDay(storedToDay(project.deadline)),
      profileWaiting: Boolean(stored?.profileWaiting),
      href: `${appUrl()}/${locale}/student/applications/${application.id}`,
    }),
    type: 'application_received',
    userId: user.id,
  })
}
