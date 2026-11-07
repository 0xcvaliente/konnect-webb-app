import { APIError, type Payload, type PayloadRequest } from 'payload'

import type { ApplyError } from './fields'
import { RUNNING_PROJECT_STATUSES } from './fields'

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
