import { APIError } from 'payload'

import type { Role } from '@/access/roles'

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
