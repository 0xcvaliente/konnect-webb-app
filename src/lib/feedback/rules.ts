import { APIError, type Payload, type PayloadRequest } from 'payload'

import { type AccessUser, companyIdOf, isCompany, isStudent, relationId } from '@/access/roles'
import { ACTIVE_MATCH } from '@/lib/problems/rules'

import type { FeedbackError, FeedbackSide } from './fields'

type Rel = number | { id: number } | null | undefined

export const feedbackError = (code: FeedbackError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

export type FeedbackTarget = {
  side: FeedbackSide
  projectId: number
  /** The student's match on the project (student feedback only). */
  matchId: number | null
}

/**
 * Who may give feedback on a project, and as which side: the project closed after delivery, and
 * the user is the company that owns it or the student whose match on it Konnected did not end.
 * Returns the reason as an error code when not.
 *
 * Bypass: the server reads the project's status and company and the match's student with
 * `overrideAccess: true` (a student no longer reads a closed project); only yes or no, the side
 * and the ids leave here. Pass `req` inside a hook so the reads join its transaction.
 */
export async function feedbackTarget(
  payload: Payload,
  user: AccessUser | null | undefined,
  projectId: number | undefined,
  req?: PayloadRequest,
): Promise<FeedbackTarget | FeedbackError> {
  if (!user || !(isStudent(user) || isCompany(user))) return 'forbidden'
  if (!projectId) return 'not_found'
  const project = await payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { status: true, closeOutcome: true, company: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project) return 'not_found'

  let target: FeedbackTarget | null = null
  if (isCompany(user)) {
    const companyId = companyIdOf(user)
    if (!companyId || relationId(project.company as Rel) !== companyId) return 'not_found'
    target = { side: 'company', projectId, matchId: null }
  } else {
    const found = await payload.find({
      collection: 'matches',
      where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
      limit: 1,
      depth: 0,
      select: { student: true },
      overrideAccess: true,
      req,
    })
    const match = found.docs[0]
    const profile = match
      ? await payload.findByID({
          collection: 'student-profiles',
          id: relationId(match.student as Rel)!,
          depth: 0,
          select: { user: true },
          overrideAccess: true,
          disableErrors: true,
          req,
        })
      : null
    if (!match || relationId(profile?.user as Rel) !== user.id) return 'not_found'
    target = { side: 'student', projectId, matchId: match.id }
  }
  // Projects closed before the close outcome existed were all closed after delivery.
  const delivered = (project.closeOutcome ?? 'delivered') === 'delivered'
  if (project.status !== 'closed' || !delivered) return 'not_open'
  return target
}
