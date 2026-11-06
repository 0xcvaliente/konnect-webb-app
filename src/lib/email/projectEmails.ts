import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { priceBreakdown } from '@/lib/money'
import type { Project } from '@/payload-types'

import { type EmailType, sendEmail } from './send'
import {
  type EmailLocale,
  emailLocale,
  projectReviewEmail,
  type ProjectReviewKind,
  projectSubmittedEmail,
} from './templates'

type Rel = number | { id: number } | null | undefined

/** The company's own page for a project, in the given language. */
export const companyProjectLink = (locale: 'en' | 'no', id: number): string =>
  `${appUrl()}/${locale}/company/projects/${id}`

/**
 * The address and language of a company's one user.
 *
 * Bypass: the server reads the company and its user with `overrideAccess: true` to get the
 * address; the acting user may be an admin or the company itself. Only the address, the language
 * and the id are used, and the address is never logged (sendEmail logs the type and the user id).
 */
export async function companyRecipient(
  req: PayloadRequest,
  companyId: number | undefined,
): Promise<{ id: number; email: string; locale: EmailLocale } | null> {
  if (!companyId) return null
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

/**
 * Tell the company that Konnected received its project for review, in the company user's saved
 * language. Called from the Projects afterChange hook, so it covers every way a project is sent.
 */
export async function sendProjectSubmittedEmail(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'title' | 'company'>,
): Promise<void> {
  const to = await companyRecipient(req, relationId(project.company as Rel))
  if (!to) return
  await sendEmail(req.payload, {
    to: to.email,
    email: projectSubmittedEmail(
      to.locale,
      project.title,
      companyProjectLink(to.locale, project.id),
    ),
    type: 'project_submitted',
    userId: to.id,
  })
}

const PROJECT_REVIEW_TYPE: Record<ProjectReviewKind, EmailType> = {
  changes_requested: 'project_changes_requested',
  rejected: 'project_rejected',
  approved: 'project_approved',
  published: 'project_published',
}

/**
 * Tell the company what Konnected decided on its project: changes asked or rejected (with the
 * team's note), approved (with the fixed price when paid), or published. Called from the Projects
 * afterChange hook. Nothing about any student is in it.
 */
export async function sendProjectReviewEmail(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'title' | 'company' | 'noteToCompany' | 'fee' | 'paidOrUnpaid'>,
  kind: ProjectReviewKind,
): Promise<void> {
  const to = await companyRecipient(req, relationId(project.company as Rel))
  if (!to) return
  const fee = project.paidOrUnpaid === 'paid' && project.fee ? priceBreakdown(project.fee) : null
  await sendEmail(req.payload, {
    to: to.email,
    email: projectReviewEmail(to.locale, kind, {
      title: project.title,
      note: project.noteToCompany,
      price: fee,
      href:
        kind === 'changes_requested'
          ? `${companyProjectLink(to.locale, project.id)}/edit`
          : companyProjectLink(to.locale, project.id),
    }),
    type: PROJECT_REVIEW_TYPE[kind],
    userId: to.id,
  })
}
