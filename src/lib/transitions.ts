import { APIError, type PayloadRequest } from 'payload'

import type { Role } from '@/access/roles'
import { assertCompanyAgreementSigned, assertStudentAgreementSigned } from '@/lib/agreements/gates'

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
 * Project moves that also need a signed agreement (konnected-agreements): `approved` to
 * `published` needs the company agreement, `matched` to `in_progress` the student agreement, each
 * signed by the party and by Konnected. Call after assertTransition, for every role.
 */
export async function assertProjectGates(
  req: PayloadRequest,
  from: ProjectStatus,
  to: ProjectStatus,
  projectId: number | undefined,
): Promise<void> {
  if (from === 'approved' && to === 'published') await assertCompanyAgreementSigned(req, projectId)
  if (from === 'matched' && to === 'in_progress') await assertStudentAgreementSigned(req, projectId)
}

export type CompanyStatus = 'pending' | 'approved' | 'rejected'

export const COMPANY_TRANSITIONS: TransitionMap<CompanyStatus> = {
  pending: { approved: ['admin'], rejected: ['admin'] },
  rejected: { pending: ['admin'] },
  approved: { rejected: ['admin'] },
}

export type ApplicationStatus =
  'applied' | 'shortlisted' | 'selected' | 'not_selected' | 'withdrawn'

export const APPLICATION_TRANSITIONS: TransitionMap<ApplicationStatus> = {
  applied: { shortlisted: ['admin'], withdrawn: ['student'] },
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
