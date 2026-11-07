import { APIError, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { assertRoomForAnotherProject } from '@/lib/applications/rules'
import { lockRow } from '@/lib/db/locks'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { sendSelectionEmails } from '@/lib/email/matchingEmails'
import type { Application, Match } from '@/payload-types'

import type { MatchError } from './fields'

/**
 * The server rules behind selecting a student (Kanban card "Admin applications queue and manual
 * matching"). The Applications hook calls them for every API (the team's Matching screen, REST,
 * GraphQL, the Local API and Payload's own admin panel), so the rules cannot be skipped.
 *
 * Reads use `overrideAccess: true` where the rule needs what the acting user may not read in
 * every state (a project that is no longer published); writes run as the acting team member with
 * `overrideAccess: false`, so each collection's own access rules and hooks apply to them too.
 */

type Rel = number | { id: number } | null | undefined

/** Context key: the application being selected, while its selection runs. Server only. */
export const SELECTION_CONTEXT = 'selectionOf'

export const selectionOf = (req: PayloadRequest): number | undefined => {
  const value = (req.context as Record<string, unknown> | undefined)?.[SELECTION_CONTEXT]
  return typeof value === 'number' ? value : undefined
}

/** An APIError with a code the team's screen maps to its own message. */
export const matchError = (code: MatchError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

/**
 * Before an application's status changes: lock the project, then the application, and read the
 * status again. Two team members deciding at once (or the student withdrawing while the team
 * selects) then run one after the other, and the second sees what the first did. Throws when the
 * status changed since the request read the document.
 */
export async function lockApplicationForDecision(
  req: PayloadRequest,
  application: Pick<Application, 'id' | 'project' | 'status'>,
): Promise<void> {
  const projectId = relationId(application.project as Rel)
  if (projectId) await lockRow(req, 'projects', projectId)
  await lockRow(req, 'applications', application.id)
  const now = await req.payload.findByID({
    collection: 'applications',
    id: application.id,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!now || now.status !== application.status) {
    throw matchError('not_open', 'The application changed meanwhile. Load it again.', 409)
  }
}

/**
 * Throw unless Konnected may select this application now: the project is still published and has
 * no match, the student's profile is reviewed (Konnected reviews every profile before matching),
 * and the student has room for one more project (at most 2 running or picked; that check locks
 * the student's profile row, so two selections of one student run one after the other).
 *
 * Call after lockApplicationForDecision, inside the same transaction.
 */
export async function assertCanSelect(
  req: PayloadRequest,
  application: Pick<Application, 'id' | 'project' | 'student'>,
): Promise<void> {
  const projectId = relationId(application.project as Rel)
  const studentId = relationId(application.student as Rel)
  if (!projectId || !studentId) throw matchError('not_found', 'The application is incomplete', 400)

  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!project || project.status !== 'published') {
    throw matchError(
      'project_not_open',
      'Only a published project can be matched. It may have been matched already.',
      409,
    )
  }
  const matched = await req.payload.count({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    overrideAccess: true,
    req,
  })
  if (matched.totalDocs > 0) {
    throw matchError('already_matched', 'This project already has a student', 409)
  }

  const profile = await req.payload.findByID({
    collection: 'student-profiles',
    id: studentId,
    depth: 0,
    select: { reviewStatus: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (profile?.reviewStatus !== 'reviewed') {
    throw matchError(
      'profile_not_reviewed',
      'Review the student profile before selecting this student',
      403,
    )
  }

  await assertRoomForAnotherProject(req, studentId, projectId)
}

/**
 * A project moves to `matched` only with its match (made by a selection). Throws otherwise, so the
 * status can never say "matched" without a student behind it, whatever API moves it.
 */
export async function assertProjectHasMatch(
  req: PayloadRequest,
  projectId: number | undefined,
): Promise<void> {
  const found = projectId
    ? await req.payload.count({
        collection: 'matches',
        where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
        overrideAccess: true,
        req,
      })
    : { totalDocs: 0 }
  if (found.totalDocs === 0) {
    throw matchError(
      'not_found',
      'A project is matched by selecting a student in Matching, not by changing its status',
      409,
    )
  }
}

/**
 * After an application became `selected`, in the same transaction: create the match (its hook
 * copies only what the student ticked to share), mark every other open application on the project
 * `not_selected`, and move the project to `matched`. Each write goes through its collection's
 * hooks, so each is checked and written to the activity log. The emails go out last, after the
 * response, only when every write succeeded.
 */
export async function completeSelection(
  req: PayloadRequest,
  application: Pick<Application, 'id' | 'project' | 'student'>,
): Promise<Match> {
  const projectId = relationId(application.project as Rel)!
  const studentId = relationId(application.student as Rel)!
  // Lets the Matches hook tell a match made by a selection from any other attempt to make one.
  req.context = { ...(req.context ?? {}), [SELECTION_CONTEXT]: application.id }

  const match = await req.payload.create({
    collection: 'matches',
    data: { project: projectId, student: studentId, application: application.id },
    overrideAccess: false,
    req,
  })

  const others = await req.payload.find({
    collection: 'applications',
    where: {
      and: [
        { project: { equals: projectId } },
        { id: { not_equals: application.id } },
        { status: { in: ['applied', 'shortlisted'] } },
      ],
    },
    depth: 0,
    pagination: false,
    select: { status: true },
    overrideAccess: false,
    req,
  })
  for (const other of others.docs) {
    await req.payload.update({
      collection: 'applications',
      id: other.id,
      data: { status: 'not_selected' },
      overrideAccess: false,
      req,
    })
  }

  await req.payload.update({
    collection: 'projects',
    id: projectId,
    data: { status: 'matched' },
    overrideAccess: false,
    req,
  })

  await sendSelectionEmails(req, {
    projectId,
    selectedApplicationId: application.id,
    studentId,
    notSelectedApplicationIds: others.docs.map((o) => o.id),
    shared: match.sharedInfo ?? null,
  })
  return match
}
