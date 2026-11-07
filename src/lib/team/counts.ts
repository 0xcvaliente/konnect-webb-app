import type { Payload } from 'payload'

import type { TeamNavKey } from '@/components/app/nav'

import { approvalCounts, type SessionUser } from './approvals'
import { matchingCount } from './matching'

/**
 * The numbers next to the team menu items: open items per queue, read as the team member.
 * Queues that do not exist yet show no number.
 */
export async function teamCounts(
  payload: Payload,
  user: SessionUser,
): Promise<Partial<Record<TeamNavKey, number>>> {
  const [approvals, matching] = await Promise.all([
    approvalCounts(payload, user),
    matchingCount(payload, user),
  ])
  return approvals
    ? { approvals: approvals.companies + approvals.projects + approvals.students, matching }
    : {}
}
