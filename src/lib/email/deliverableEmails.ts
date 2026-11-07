import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { appUrl } from '@/lib/auth/env'
import { fixUntilDay } from '@/lib/deliverables/fields'
import type { Deliverable } from '@/payload-types'

import { studentRecipient } from './matchingEmails'
import { companyProjectLink, companyRecipient } from './projectEmails'
import { sendEmail } from './send'
import {
  deliverableAcceptedEmail,
  deliverableFixEmail,
  deliverableReleasedEmail,
  deliverableReturnedEmail,
} from './templates'

type Rel = number | { id: number } | null | undefined

/**
 * The emails of the hand-off (Kanban card "Deliverable submission and handoff"), each in the
 * recipient's saved language:
 * - released: to the company (accept, or ask for one round of fixes within 7 days);
 * - returned (Konnected asked for more): to the student;
 * - fix requested: to the student;
 * - accepted (by the company, the team, or after 7 days): to the student and the company.
 *
 * Minimal personal data: the company's email names no student; the notes (the team's, the
 * company's) are not repeated; everything else waits behind sign-in.
 *
 * Bypass: the server reads the match, the project's title and company, and the recipients'
 * addresses with `overrideAccess: true`. Only the email type and the user id are logged.
 */
export async function sendDeliverableEmails(
  req: PayloadRequest,
  deliverable: Pick<Deliverable, 'id' | 'status' | 'match' | 'releasedAt' | 'acceptedBy'>,
): Promise<void> {
  const matchId = relationId(deliverable.match as Rel)
  if (!matchId) return
  const match = await req.payload.findByID({
    collection: 'matches',
    id: matchId,
    depth: 0,
    select: { project: true, student: true, application: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  const projectId = relationId(match?.project as Rel)
  if (!match || !projectId) return
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { title: true, companyName: true, company: true, paidOrUnpaid: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project) return
  const title = project.title
  const company = project.companyName ?? ''
  const paid = project.paidOrUnpaid === 'paid'
  const applicationId = relationId(match.application as Rel)
  const studentLink = (locale: 'en' | 'no') =>
    applicationId
      ? `${appUrl()}/${locale}/student/applications/${applicationId}`
      : `${appUrl()}/${locale}/student/applications`

  const toStudent = async () => studentRecipient(req, relationId(match.student as Rel))
  const toCompany = async () => companyRecipient(req, relationId(project.company as Rel))

  if (deliverable.status === 'released') {
    const to = await toCompany()
    if (!to) return
    // A release after a fix request is the fixed work: the company can only accept it now.
    const earlier = await req.payload.count({
      collection: 'deliverables',
      where: {
        and: [
          { match: { equals: matchId } },
          { id: { not_equals: deliverable.id } },
          { fixRequestedAt: { exists: true } },
        ],
      },
      overrideAccess: true,
      req,
    })
    await sendEmail(req.payload, {
      to: to.email,
      email: deliverableReleasedEmail(to.locale, {
        title,
        fixUntil: fixUntilDay(deliverable.releasedAt ?? new Date()),
        paid,
        fixRound: earlier.totalDocs > 0,
        href: companyProjectLink(to.locale, projectId),
      }),
      type: 'deliverable_released',
      userId: to.id,
    })
    return
  }

  if (deliverable.status === 'returned' || deliverable.status === 'fix_requested') {
    const to = await toStudent()
    if (!to) return
    await sendEmail(req.payload, {
      to: to.email,
      email:
        deliverable.status === 'returned'
          ? deliverableReturnedEmail(to.locale, { title, href: studentLink(to.locale) })
          : deliverableFixEmail(to.locale, { title, company, href: studentLink(to.locale) }),
      type:
        deliverable.status === 'returned' ? 'deliverable_returned' : 'deliverable_fix_requested',
      userId: to.id,
    })
    return
  }

  if (deliverable.status === 'accepted') {
    const auto = deliverable.acceptedBy === 'auto'
    const student = await toStudent()
    if (student) {
      await sendEmail(req.payload, {
        to: student.email,
        email: deliverableAcceptedEmail(student.locale, {
          to: 'student',
          title,
          company,
          auto,
          paid,
          href: studentLink(student.locale),
        }),
        type: 'deliverable_accepted',
        userId: student.id,
      })
    }
    const companyUser = await toCompany()
    if (companyUser) {
      await sendEmail(req.payload, {
        to: companyUser.email,
        email: deliverableAcceptedEmail(companyUser.locale, {
          to: 'company',
          title,
          company,
          auto,
          paid,
          href: companyProjectLink(companyUser.locale, projectId),
        }),
        type: 'deliverable_accepted',
        userId: companyUser.id,
      })
    }
  }
}
