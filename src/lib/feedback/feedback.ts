import type { Payload } from 'payload'

import { isAdmin, isCompany, isStudent, relationId } from '@/access/roles'
import type { SessionUser } from '@/lib/students/profile'
import type { Feedback } from '@/payload-types'

import {
  cleanText,
  FEEDBACK_TEXT_MAX,
  type FeedbackError,
  feedbackErrorCode,
  type FeedbackSide,
  type FeedbackState,
  isRating,
} from './fields'
import { feedbackTarget } from './rules'

/**
 * Feedback after a project: whether the student or company may still give it, sending it, and
 * the team's view. The student and the company read only their own row (to know it was sent),
 * as themselves with access control on; the team reads every row as the team member.
 */

const asUser = (user: SessionUser) => ({ user, overrideAccess: false as const })

/** `open`: the form can be sent. `sent`: it was. `none`: no feedback on this project (yet). */
export type FeedbackStatus = 'open' | 'sent' | 'none'

export async function feedbackStatus(
  payload: Payload,
  user: SessionUser | null,
  projectId: number | null,
): Promise<FeedbackStatus> {
  if (!user || !(isStudent(user) || isCompany(user)) || !projectId) return 'none'
  const target = await feedbackTarget(payload, user, projectId)
  if (typeof target === 'string') return 'none'
  const own = await payload.count({
    collection: 'feedback',
    where: { project: { equals: projectId } },
    ...asUser(user),
  })
  return own.totalDocs > 0 ? 'sent' : 'open'
}

const fail = (error: FeedbackError): FeedbackState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})

/** Send the short form. The hook checks again who may, and that it is the first time. */
export async function sendFeedback(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<FeedbackState> {
  if (!user || !(isStudent(user) || isCompany(user))) return fail('forbidden')
  const raw = form.get('projectId')
  const projectId = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
  if (!projectId) return fail('not_found')
  const rating = Number(form.get('rating'))
  if (!isRating(rating)) return fail('rating_required')
  const wentWell = cleanText(form.get('wentWell'))
  const couldBeBetter = cleanText(form.get('couldBeBetter'))
  if (
    (wentWell?.length ?? 0) > FEEDBACK_TEXT_MAX ||
    (couldBeBetter?.length ?? 0) > FEEDBACK_TEXT_MAX
  )
    return fail('too_long')
  try {
    await payload.create({
      collection: 'feedback',
      data: {
        project: projectId,
        rating,
        wentWell,
        couldBeBetter,
        again: form.get('again') === 'on' || form.get('again') === 'true',
      } as never,
      ...asUser(user),
    })
  } catch (error) {
    const code = feedbackErrorCode(error)
    if (code) return fail(code)
    payload.logger.error({
      msg: 'Feedback failed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return fail('generic')
  }
  return { status: 'done', doneAt: Date.now() }
}

export type TeamFeedback = {
  id: number
  side: FeedbackSide
  rating: number
  wentWell: string | null
  couldBeBetter: string | null
  again: boolean
  createdAt: string
}

/** The feedback on one project, for the team's project page. */
export async function listProjectFeedback(
  payload: Payload,
  actor: SessionUser | null,
  projectId: number,
): Promise<TeamFeedback[]> {
  if (!actor || !isAdmin(actor)) return []
  const found = await payload.find({
    collection: 'feedback',
    where: { project: { equals: projectId } },
    depth: 0,
    pagination: false,
    sort: 'createdAt',
    ...asUser(actor),
  })
  return (found.docs as Feedback[]).map((f) => ({
    id: f.id,
    side: (f.side ?? 'student') as FeedbackSide,
    rating: f.rating,
    wentWell: f.wentWell ?? null,
    couldBeBetter: f.couldBeBetter ?? null,
    again: Boolean(f.again),
    createdAt: f.createdAt,
  }))
}

/** Project ids with feedback from each side, for a list of projects (team). */
export async function feedbackSidesByProject(
  payload: Payload,
  actor: SessionUser | null,
  projectIds: number[],
): Promise<Map<number, Set<FeedbackSide>>> {
  const map = new Map<number, Set<FeedbackSide>>()
  if (!actor || !isAdmin(actor) || !projectIds.length) return map
  const found = await payload.find({
    collection: 'feedback',
    where: { project: { in: projectIds } },
    depth: 0,
    pagination: false,
    select: { project: true, side: true },
    ...asUser(actor),
  })
  for (const f of found.docs) {
    const id = relationId(f.project as number)!
    if (!map.has(id)) map.set(id, new Set())
    map.get(id)!.add((f.side ?? 'student') as FeedbackSide)
  }
  return map
}
