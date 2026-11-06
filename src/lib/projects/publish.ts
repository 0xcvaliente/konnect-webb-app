import { APIError, type PayloadRequest } from 'payload'

import { isValidPrice } from '@/lib/money'
import type { Project } from '@/payload-types'

/**
 * The one gate for `approved -> published`. The Projects hook calls it for every API, so the team
 * page, the admin panel, REST and GraphQL all meet the same rule.
 *
 * Today it checks what the review settled: Konnected's paid or unpaid decision, and a fixed price
 * for a paid project. The agreements card (run 3) extends this function with "the company signed
 * the company agreement for this project"; keep every publishing rule here, not in callers.
 *
 * `project` is the stored project with the update merged in. `req` carries the transaction, so a
 * later check can read related records with it.
 */
export async function assertCanPublish(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'paidOrUnpaid' | 'fee'>,
): Promise<void> {
  void req
  if (project.paidOrUnpaid !== 'paid' && project.paidOrUnpaid !== 'unpaid') {
    throw new APIError('Project: decide paid or unpaid before publishing', 400)
  }
  if (project.paidOrUnpaid === 'paid' && !isValidPrice(project.fee)) {
    throw new APIError('Project: a paid project needs a fixed price before publishing', 400)
  }
}

/**
 * What approving a project needs: Konnected's paid or unpaid decision and, for a paid project, a
 * fixed price in whole kroner. Shared by the hook (approve) and the team page.
 */
export function approvalProblem(
  project: Pick<Project, 'paidOrUnpaid' | 'fee'>,
): 'pay_choice' | 'price' | null {
  if (project.paidOrUnpaid !== 'paid' && project.paidOrUnpaid !== 'unpaid') return 'pay_choice'
  if (project.paidOrUnpaid === 'paid' && !isValidPrice(project.fee)) return 'price'
  return null
}
