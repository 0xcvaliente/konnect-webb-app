import { APIError, type Payload, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'

import type { ApplyError } from './fields'
import { MAX_RUNNING_PROJECTS, RUNNING_PROJECT_STATUSES } from './fields'

/**
 * Server-side counts and errors for applications. Used by the Applications hook (with `req`, so
 * the reads join the request's transaction) and by the student pages.
 */

/**
 * How many projects the student works on now: matches whose project is matched or in progress.
 *
 * Bypass: `overrideAccess: true`. The query filters on the project's status, which a student may
 * not read for a project that is no longer published; only the number leaves this function.
 */
export async function runningProjectCount(
  payload: Payload,
  profileId: number,
  req?: PayloadRequest,
): Promise<number> {
  const { totalDocs } = await payload.count({
    collection: 'matches',
    where: {
      and: [
        { student: { equals: profileId } },
        { 'project.status': { in: [...RUNNING_PROJECT_STATUSES] } },
      ],
    },
    overrideAccess: true,
    ...(req ? { req } : {}),
  })
  return totalDocs
}

/**
 * Throw unless the team may pick the student for one more project: when an application becomes
 * `selected` and when a match is created, or changes its student or project.
 *
 * Counted, each project once and leaving out the project being decided: the running projects
 * (above), plus the picks still waiting for the project to move to `matched`, so two picks made
 * one after the other cannot add up to more than 2 running projects:
 * - a match whose project is still published (the team moves it to matched after the match);
 * - a selected application whose project is still published (no match yet).
 * `exceptMatchId` leaves out the match being changed.
 *
 * Bypass: `overrideAccess: true`, for the same reason as runningProjectCount. Only the decision
 * leaves this function.
 */
export async function assertRoomForAnotherProject(
  req: PayloadRequest,
  profileId: number | null | undefined,
  projectId: number | null | undefined,
  exceptMatchId?: number,
): Promise<void> {
  if (!profileId) return
  const [matches, selected] = await Promise.all([
    req.payload.find({
      collection: 'matches',
      where: {
        and: [
          { student: { equals: profileId } },
          { 'project.status': { in: ['published', ...RUNNING_PROJECT_STATUSES] } },
          ...(exceptMatchId ? [{ id: { not_equals: exceptMatchId } }] : []),
        ],
      },
      depth: 0,
      pagination: false,
      select: { project: true },
      overrideAccess: true,
      req,
    }),
    req.payload.find({
      collection: 'applications',
      where: {
        and: [
          { student: { equals: profileId } },
          { status: { equals: 'selected' } },
          { 'project.status': { equals: 'published' } },
        ],
      },
      depth: 0,
      pagination: false,
      select: { project: true },
      overrideAccess: true,
      req,
    }),
  ])
  const projects = new Set<number>()
  for (const doc of [...matches.docs, ...selected.docs]) {
    const id = relationId(doc.project)
    if (id && id !== projectId) projects.add(id)
  }
  if (projects.size >= MAX_RUNNING_PROJECTS) {
    throw applyError(
      'too_many',
      `The student already has ${MAX_RUNNING_PROJECTS} projects running or picked, the most at one time`,
      403,
    )
  }
}

/**
 * An APIError that carries a code the student pages map to their own message. The English
 * message is for the API and the admin panel.
 */
export const applyError = (code: ApplyError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

/** The code on an error thrown by the Applications hook, if it has one. */
export function applyErrorCode(error: unknown): ApplyError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string') return code as ApplyError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
