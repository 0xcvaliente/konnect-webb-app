import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import type { Project } from '@/payload-types'

import { sendEmail } from './send'
import { emailLocale, projectSubmittedEmail } from './templates'

type Rel = number | { id: number } | null | undefined

/** The company's own page for a project, in the given language. */
export const companyProjectLink = (locale: 'en' | 'no', id: number): string =>
  `${appUrl()}/${locale}/company/projects/${id}`

/**
 * Tell the company that Konnected received its project for review, in the company user's saved
 * language. Called from the Projects afterChange hook, so it covers every way a project is sent.
 *
 * Bypass: the server reads the company's one user with `overrideAccess: true` to get the address;
 * the acting user may be an admin or the company itself. Only the address and the language are
 * used, and neither is logged (sendEmail logs the type and the user id only).
 */
export async function sendProjectSubmittedEmail(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'title' | 'company'>,
): Promise<void> {
  const companyId = relationId(project.company as Rel)
  if (!companyId) return
  const company = await req.payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    select: { user: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const userId = relationId(company?.user as Rel)
  if (!userId) return
  const user = await req.payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    select: { email: true, language: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!user?.email) return
  const locale = emailLocale(user.language)
  await sendEmail(req.payload, {
    to: user.email,
    email: projectSubmittedEmail(locale, project.title, companyProjectLink(locale, project.id)),
    type: 'project_submitted',
    userId: user.id,
  })
}
