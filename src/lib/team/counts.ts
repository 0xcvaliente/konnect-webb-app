import type { Payload } from 'payload'

import type { TeamNavKey } from '@/components/app/nav'

import { approvalCounts, type SessionUser } from './approvals'
import { deliverablesCount } from './deliverables'
import { matchingCount } from './matching'
import { mineIds } from './members'
import { paymentsCount } from './payments'
import { questionsCount } from '@/lib/questions/team'
import { itemsOf, loadToday, type TodayData } from './today'

/**
 * The numbers next to the team menu items: open items per queue, read as the team member, and on
 * Today the items that are the member's own (with those of anyone they cover today). Queues that
 * do not exist yet show no number. Pass `today` when the page already loaded it.
 */
export async function teamCounts(
  payload: Payload,
  user: SessionUser,
  today?: TodayData | null,
): Promise<Partial<Record<TeamNavKey, number>>> {
  const [approvals, matching, deliverables, payments, questions, data] = await Promise.all([
    approvalCounts(payload, user),
    matchingCount(payload, user),
    deliverablesCount(payload, user),
    paymentsCount(payload, user),
    questionsCount(payload, user),
    today === undefined ? loadToday(payload, user) : today,
  ])
  const mine = data ? itemsOf(data.items, mineIds(data.team, user.id, data.today)).length : 0
  return approvals
    ? {
        today: mine,
        approvals: approvals.companies + approvals.projects + approvals.students,
        matching,
        deliverables,
        questions,
        payments,
      }
    : {}
}
