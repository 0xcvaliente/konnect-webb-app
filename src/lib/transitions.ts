import { APIError, type PayloadRequest } from 'payload'

import type { Role } from '@/access/roles'
import type { Project } from '@/payload-types'
import { assertStudentAgreementSigned } from '@/lib/agreements/gates'
import { assertProjectHasMatch } from '@/lib/matching/rules'

/** from -> to -> roles allowed to make that move. Anything not listed is rejected. */
export type TransitionMap<S extends string> = Partial<Record<S, Partial<Record<S, Role[]>>>>

export type ProjectStatus =
  | 'draft'
  | 'submitted'
  | 'changes_requested'
  | 'rejected'
  | 'approved'
  | 'published'
  | 'matched'
  | 'in_progress'
  | 'delivered'
  | 'closed'

export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  draft: { submitted: ['company', 'admin'] },
  submitted: {
    changes_requested: ['admin'],
    rejected: ['admin'],
    approved: ['admin'],
  },
  changes_requested: { submitted: ['company', 'admin'] },
  approved: { published: ['admin'] },
  published: { matched: ['admin'] },
  matched: { in_progress: ['admin'] },
  // The student delivering is wired up by the deliverables card. Admin only until then.
  in_progress: { delivered: ['admin'] },
  delivered: { closed: ['admin'] },
}

/**
 * Project moves that also need something else. `published` to `matched` needs the match, which
 * only selecting an application makes (lib/matching/rules.ts: the selection moves the project
 * itself). Moves that need a signed agreement (konnected-agreements): `matched` to
 * `in_progress` needs the student agreement, signed by the student and by Konnected, and still
 * matching the project and match. Call after assertTransition, for every role, with the project
 * as it will be saved (the stored project with this request's changes).
 *
 * The other gate, the company agreement before `approved` to `published`, is part of the one
 * publishing rule, assertCanPublish (lib/projects/publish.ts), which the Projects hook runs for
 * every way of publishing, the team's approval queue included.
 */
export async function assertProjectGates(
  req: PayloadRequest,
  from: ProjectStatus,
  to: ProjectStatus,
  project: Project | undefined,
): Promise<void> {
  if (from === 'published' && to === 'matched') await assertProjectHasMatch(req, project?.id)
  if (from === 'matched' && to === 'in_progress') await assertStudentAgreementSigned(req, project)
}

export type CompanyStatus = 'pending' | 'approved' | 'rejected'

/**
 * A rejected company may correct its details and send them again once (owner decision): the
 * Companies hook moves it back to `pending` on its own save, and only while `resentAt` is empty.
 */
export const COMPANY_TRANSITIONS: TransitionMap<CompanyStatus> = {
  pending: { approved: ['admin'], rejected: ['admin'] },
  rejected: { pending: ['admin', 'company'] },
  approved: { rejected: ['admin'] },
}

/**
 * Konnected's review of a student profile. Only the team decides. When the team asked for
 * changes, the student's own edit sends the profile back to `waiting` (the StudentProfiles hook
 * makes that move; the student never sends a status).
 */
export type ProfileReviewStatus = 'waiting' | 'changes_requested' | 'reviewed'

export const PROFILE_REVIEW_TRANSITIONS: TransitionMap<ProfileReviewStatus> = {
  waiting: { reviewed: ['admin'], changes_requested: ['admin'] },
  changes_requested: { waiting: ['student', 'admin'], reviewed: ['admin'] },
  reviewed: { changes_requested: ['admin'], waiting: ['admin'] },
}

export type ApplicationStatus =
  'applied' | 'shortlisted' | 'selected' | 'not_selected' | 'withdrawn'

/**
 * Konnected may select straight from `applied` (the mockup's Select button is on every reviewed
 * applicant), and selecting one marks every other open application on the project
 * `not_selected` (the Applications hook does that, in the same transaction).
 */
export const APPLICATION_TRANSITIONS: TransitionMap<ApplicationStatus> = {
  applied: {
    shortlisted: ['admin'],
    selected: ['admin'],
    not_selected: ['admin'],
    withdrawn: ['student'],
  },
  shortlisted: { selected: ['admin'], not_selected: ['admin'], withdrawn: ['student'] },
}

export type DeliverableStatus = 'submitted' | 'released'

export const DELIVERABLE_TRANSITIONS: TransitionMap<DeliverableStatus> = {
  submitted: { released: ['admin'] },
}

/**
 * A user's role. `pending` picks student or company once, themselves (the role step). After
 * that only Konnected fixes a wrong pick, between student and company, and only before the
 * account has applications or projects (checked in the Users hook). Nothing here leads to or from
 * `admin`: admin comes only from the ADMIN_EMAILS list, set by the sign-in code.
 */
export const ROLE_TRANSITIONS: TransitionMap<Role> = {
  pending: { student: ['pending'], company: ['pending'] },
  student: { company: ['admin'] },
  company: { student: ['admin'] },
}

/** Pausing and reactivating an account: the Konnected team only. */
export type AccountStatus = 'active' | 'paused'

export const ACCOUNT_TRANSITIONS: TransitionMap<AccountStatus> = {
  active: { paused: ['admin'] },
  paused: { active: ['admin'] },
}

/**
 * Throw unless `from -> to` is a listed move that `role` may make. Same status is not a move.
 * 400 for a move that does not exist, 403 for a move that exists but not for this role.
 */
export function assertTransition<S extends string>(
  map: TransitionMap<S>,
  from: S,
  to: S,
  role: Role | undefined,
  label: string,
): void {
  if (from === to) return
  const allowed = map[from]?.[to]
  if (!allowed) {
    throw new APIError(`${label}: ${from} to ${to} is not a valid change`, 400)
  }
  if (!role || !allowed.includes(role)) {
    throw new APIError(`${label}: your role cannot change ${from} to ${to}`, 403)
  }
}

export function assertInitialStatus<S extends string>(
  initial: S,
  actual: S | undefined,
  label: string,
): void {
  if (actual !== undefined && actual !== initial) {
    throw new APIError(`${label} must start as ${initial}`, 400)
  }
}
