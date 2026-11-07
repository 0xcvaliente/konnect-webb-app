import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { sharedItemsOf } from '@/lib/matching/fields'
import type { Match } from '@/payload-types'

import { companyProjectLink, companyRecipient } from './projectEmails'
import { sendEmail } from './send'
import {
  type EmailLocale,
  emailLocale,
  notSelectedEmail,
  selectedEmail,
  studentFoundEmail,
} from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * The emails of a selection (Kanban card "Admin applications queue and manual matching"): to the
 * selected student, a kind note to each student who was not selected, and "We found your student"
 * to the company. Each in the recipient's saved language.
 *
 * The company's email names only the KINDS of details the student agreed to share ("name, CV"),
 * never the values: the details stay behind sign-in on the project page (konnected-email,
 * minimal personal data). Nothing about the other applicants reaches the company.
 *
 * Bypass: the server reads each student's address and language, and the project's title and
 * company name, with `overrideAccess: true`. Only the email type and the user id are logged.
 */

/** A student's own address and language, from their profile or application. */
async function studentRecipient(
  req: PayloadRequest,
  profileId: number | undefined,
): Promise<{ id: number; email: string; locale: EmailLocale } | null> {
  if (!profileId) return null
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

async function projectFacts(req: PayloadRequest, projectId: number) {
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, companyName: true, company: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return project
    ? {
        title: project.title,
        companyName: project.companyName ?? '',
        companyId: relationId(project.company as Rel),
      }
    : null
}

/** "Konnected picked another student": to each student in `applicationIds`. */
export async function sendNotSelectedEmails(
  req: PayloadRequest,
  projectId: number | undefined,
  applicationIds: number[],
): Promise<void> {
  if (!projectId || !applicationIds.length) return
  const project = await projectFacts(req, projectId)
  if (!project) return
  for (const id of applicationIds) {
    const application = await req.payload.findByID({
      collection: 'applications',
      id,
      depth: 0,
      select: { student: true },
      overrideAccess: true,
      disableErrors: true,
      req,
    })
    const to = await studentRecipient(req, relationId(application?.student as Rel))
    if (!to) continue
    await sendEmail(req.payload, {
      to: to.email,
      email: notSelectedEmail(to.locale, {
        title: project.title,
        href: `${appUrl()}/${to.locale}/student/projects`,
      }),
      type: 'application_not_selected',
      userId: to.id,
    })
  }
}

export async function sendSelectionEmails(
  req: PayloadRequest,
  {
    projectId,
    selectedApplicationId,
    studentId,
    notSelectedApplicationIds,
    shared,
  }: {
    projectId: number
    selectedApplicationId: number
    studentId: number
    notSelectedApplicationIds: number[]
    shared: Match['sharedInfo'] | null
  },
): Promise<void> {
  const project = await projectFacts(req, projectId)
  if (!project) return
  const items = sharedItemsOf(shared)

  const student = await studentRecipient(req, studentId)
  if (student) {
    await sendEmail(req.payload, {
      to: student.email,
      email: selectedEmail(student.locale, {
        title: project.title,
        company: project.companyName,
        items,
        href: `${appUrl()}/${student.locale}/student/applications/${selectedApplicationId}`,
      }),
      type: 'application_selected',
      userId: student.id,
    })
  }

  await sendNotSelectedEmails(req, projectId, notSelectedApplicationIds)

  const company = await companyRecipient(req, project.companyId)
  if (company) {
    await sendEmail(req.payload, {
      to: company.email,
      email: studentFoundEmail(company.locale, {
        title: project.title,
        items,
        href: companyProjectLink(company.locale, projectId),
      }),
      type: 'student_found',
      userId: company.id,
    })
  }
}
