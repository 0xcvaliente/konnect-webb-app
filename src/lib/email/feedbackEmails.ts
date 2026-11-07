import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import type { Project } from '@/payload-types'

import { studentRecipient } from './matchingEmails'
import { companyRecipient } from './projectEmails'
import { sendEmail } from './send'
import { feedbackRequestEmail } from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * "How did it go?": when a project closes after delivery, the student Konnected selected and the
 * company each get one email with a link to the short feedback form, in their saved language.
 * Neither email names the other side's person. Bypass: the server reads the match and the
 * recipients' addresses with `overrideAccess: true`. Only the email type and user id are logged.
 */
export async function sendFeedbackRequests(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'title' | 'companyName' | 'company'>,
): Promise<void> {
  const found = await req.payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: project.id } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    select: { student: true, application: true },
    overrideAccess: true,
    req,
  })
  const match = found.docs[0]
  const values = { title: project.title, company: project.companyName ?? '' }
  const student = await studentRecipient(req, relationId(match?.student as Rel))
  const applicationId = relationId(match?.application as Rel)
  if (student && applicationId) {
    await sendEmail(req.payload, {
      to: student.email,
      email: feedbackRequestEmail(student.locale, 'student', {
        ...values,
        href: `${appUrl()}/${student.locale}/student/applications/${applicationId}/feedback`,
      }),
      type: 'feedback_request',
      userId: student.id,
    })
  }
  const company = await companyRecipient(req, relationId(project.company as Rel))
  if (company) {
    await sendEmail(req.payload, {
      to: company.email,
      email: feedbackRequestEmail(company.locale, 'company', {
        ...values,
        href: `${appUrl()}/${company.locale}/company/projects/${project.id}/feedback`,
      }),
      type: 'feedback_request',
      userId: company.id,
    })
  }
}
