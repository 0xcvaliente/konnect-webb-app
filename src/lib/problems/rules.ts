import { APIError, type PayloadRequest, type Where } from 'payload'

import { relationId } from '@/access/roles'
import { writeActivity } from '@/hooks/logActivity'
import { VOIDABLE } from '@/lib/agreements/fields'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import type { Match, Project } from '@/payload-types'

import { cleanText, type ProblemError, type ProblemResolution, REASON_MAX } from './fields'

/**
 * The server side of the problem paths. The Projects, Matches, Applications and ProblemReports
 * hooks call these for every API (the team's project page, REST, GraphQL, the Local API and
 * Payload's own admin panel), so the rules cannot be skipped.
 *
 * Reads use `overrideAccess: true` where the rule needs what the acting user may not read (a
 * company or a student does not read every match); writes run as the acting team member with
 * `overrideAccess: false`, so each collection's own access rules, hooks and activity log apply.
 */

type Rel = number | { id: number } | null | undefined

/** A match Konnected has not ended. At most one per project (a partial unique index). */
export const ACTIVE_MATCH: Where = { endedAt: { exists: false } }

/** Context keys the server sets. A client cannot set `req.context` through any API. */
export type ProblemContext = {
  /** The match the Projects hook is ending now. The Matches hook refuses any other end. */
  endingMatch?: number
  /** How the open reports on the match are settled by this change. */
  resolution?: ProblemResolution
  /**
   * The project whose earlier applicants go back into the pool now ("match again"). The
   * Applications hook refuses `not_selected` to `applied` without it.
   */
  returningToPool?: number
}

export const problemError = (code: ProblemError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

/**
 * The extra rules on the problem-path moves, for every role (only admins reach them; the
 * transition map refuses the rest first):
 * - closing a project that was published, matched or in progress (without a match or without
 *   delivery) needs a reason: the company and the student get it by email;
 * - ending the match and reopening applications needs a closing day today or later.
 *
 * `project` is the stored project with this request's changes.
 */
export function assertProblemPathAllowed(
  from: string,
  to: string,
  project: Pick<Project, 'closeReason' | 'deadline'> | undefined,
): void {
  if (to === 'closed') {
    const reason = cleanText(project?.closeReason)
    if (!reason) throw problemError('reason_required', 'Say why the project closes', 400)
    if (reason.length > REASON_MAX) throw problemError('reason_too_long', 'The reason is too long')
  }
  if (to === 'published' && from !== 'published') {
    const closes = storedToDay(project?.deadline)
    if (!closes || closes < todayInOslo()) {
      throw problemError(
        'date_invalid',
        'Reopening applications needs a closing day today or later',
        400,
      )
    }
  }
}

/** The project's match Konnected has not ended, if any. Bypass: a rule about the project. */
export async function activeMatchOf(
  req: PayloadRequest,
  projectId: number | null | undefined,
): Promise<Match | null> {
  if (!projectId) return null
  const found = await req.payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return (found.docs[0] as Match | undefined) ?? null
}

/** Sending a published project back to the company: only while no student is matched. */
export async function assertNoActiveMatch(
  req: PayloadRequest,
  projectId: number | undefined,
): Promise<void> {
  if (await activeMatchOf(req, projectId)) {
    throw problemError('not_open', 'The project has a student. End the match first.', 409)
  }
}

/**
 * Settle every open report on a match, as the team member making the change. Each goes through
 * the ProblemReports hook (status rules, activity log).
 */
export async function resolveOpenReports(
  req: PayloadRequest,
  matchId: number,
  resolution: ProblemResolution,
): Promise<number> {
  const open = await req.payload.find({
    collection: 'problem-reports',
    where: { and: [{ match: { equals: matchId } }, { status: { equals: 'open' } }] },
    depth: 0,
    pagination: false,
    select: { status: true },
    overrideAccess: false,
    req,
  })
  for (const report of open.docs) {
    await req.payload.update({
      collection: 'problem-reports',
      id: report.id,
      data: { status: 'resolved', resolution },
      overrideAccess: false,
      req,
    })
  }
  return open.docs.length
}

/**
 * End the project's match (the Projects hook calls this after a matched or in-progress project was
 * reopened or closed), in the same transaction, as the team member:
 * - the match gets its end time; its copy of what the student shares is emptied, so the company
 *   reads nothing about that student any more (the company no longer reads the match at all);
 * - the student's application becomes `match_ended`;
 * - an unsigned student agreement for the match is withdrawn (voided);
 * - open reports on the match are settled.
 *
 * Hand-ins stay as they are: Konnected never releases anything from an ended match (the
 * Deliverables hook refuses), and the company never read the unreleased ones.
 *
 * Returns the ended match, or null when the project had none.
 */
export async function endActiveMatch(
  req: PayloadRequest,
  projectId: number,
  resolution: ProblemResolution,
): Promise<Match | null> {
  const match = await activeMatchOf(req, projectId)
  if (!match) return null
  const context = req.context as ProblemContext
  req.context = { ...(req.context ?? {}), endingMatch: match.id, resolution }
  try {
    await req.payload.update({
      collection: 'matches',
      id: match.id,
      data: { endedAt: new Date().toISOString() },
      overrideAccess: false,
      req,
    })
  } finally {
    req.context = { ...(req.context ?? {}), endingMatch: context?.endingMatch }
  }

  const applicationId = relationId(match.application as Rel)
  if (applicationId) {
    // Bypass for the read: only the status, to skip an application that is no longer selected.
    const application = await req.payload.findByID({
      collection: 'applications',
      id: applicationId,
      depth: 0,
      select: { status: true },
      overrideAccess: true,
      disableErrors: true,
      req,
    })
    if (application?.status === 'selected') {
      await req.payload.update({
        collection: 'applications',
        id: applicationId,
        data: { status: 'match_ended' },
        overrideAccess: false,
        req,
      })
    }
  }

  // A student agreement nobody finished signing is withdrawn; a signed one stays (a contract).
  const open = await req.payload.find({
    collection: 'agreements',
    where: {
      and: [{ match: { equals: match.id } }, { status: { in: [...VOIDABLE] } }],
    },
    depth: 0,
    pagination: false,
    select: { status: true },
    overrideAccess: true,
    req,
  })
  for (const agreement of open.docs) {
    await req.payload.update({
      collection: 'agreements',
      id: agreement.id,
      data: { status: 'void' },
      overrideAccess: false,
      req,
    })
  }

  await resolveOpenReports(req, match.id, resolution)
  return match
}

/**
 * A published project closed without a match: every open application is not selected (each gets
 * the kind note the Applications hook sends), as the team member.
 */
export async function closeOpenApplications(req: PayloadRequest, projectId: number): Promise<void> {
  const open = await req.payload.find({
    collection: 'applications',
    where: {
      and: [{ project: { equals: projectId } }, { status: { in: ['applied', 'shortlisted'] } }],
    },
    depth: 0,
    pagination: false,
    select: { status: true },
    overrideAccess: false,
    req,
  })
  for (const application of open.docs) {
    await req.payload.update({
      collection: 'applications',
      id: application.id,
      data: { status: 'not_selected' },
      overrideAccess: false,
      req,
    })
  }
}

/**
 * "Match again" (owner answer 51): after the match ended and applications reopened, every earlier
 * applicant who was not selected goes back into the pool (`applied`, the normal under-review
 * state) for the new selection, as the team member, in the same transaction. Not the student who
 * was replaced (their application is `match_ended`, and any other of theirs is skipped too), and
 * never a student who withdrew (no re-applying after withdrawing). Selecting one of them later
 * meets every selection rule again (a reviewed profile, at most 2 running projects).
 *
 * Writes one `review_change` row on the project (`field` `applicationsBack`, the count in
 * `toStatus`); each application's own status change is logged by its hook. Returns the count.
 */
export async function returnApplicantsToPool(
  req: PayloadRequest,
  projectId: number,
  replacedStudentId: number | undefined,
): Promise<number> {
  const earlier = await req.payload.find({
    collection: 'applications',
    where: {
      and: [{ project: { equals: projectId } }, { status: { equals: 'not_selected' } }],
    },
    depth: 0,
    pagination: false,
    select: { student: true, status: true },
    overrideAccess: false,
    req,
  })
  const back = earlier.docs.filter((a) => relationId(a.student as Rel) !== replacedStudentId)
  if (!back.length) return 0
  const context = req.context as ProblemContext
  req.context = { ...(req.context ?? {}), returningToPool: projectId }
  try {
    for (const application of back) {
      await req.payload.update({
        collection: 'applications',
        id: application.id,
        data: { status: 'applied' },
        overrideAccess: false,
        req,
      })
    }
  } finally {
    req.context = { ...(req.context ?? {}), returningToPool: context?.returningToPool }
  }
  await writeActivity(req, {
    action: 'review_change',
    targetCollection: 'projects',
    targetId: String(projectId),
    field: 'applicationsBack',
    toStatus: String(back.length),
  })
  return back.length
}
