import { APIError, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { isValidPrice } from '@/lib/money'
import type { Project } from '@/payload-types'

/**
 * The one gate for `approved -> published`. The Projects hook calls it for every API, so the team
 * page, the admin panel, REST and GraphQL all meet the same rule.
 *
 * Today it checks that Konnected approved the company (a company rejected after its project was
 * approved, or sent back to pending by its one correction, must not reach students), and what
 * the review settled: Konnected's paid or unpaid decision, and a fixed price for a paid project. The agreements card (run 3) extends this function with "the company signed
 * the company agreement for this project"; keep every publishing rule here, not in callers.
 *
 * `project` is the stored project with the update merged in. `req` carries the transaction, so a
 * later check can read related records with it.
 */
export async function assertCanPublish(
  req: PayloadRequest,
  project: Pick<Project, 'id' | 'company' | 'paidOrUnpaid' | 'fee'>,
): Promise<void> {
  const companyId = relationId(project.company)
  // Bypass: the server reads the company's status whatever the acting user may read. Only the
  // status is used.
  const company = companyId
    ? await req.payload.findByID({
        collection: 'companies',
        id: companyId,
        depth: 0,
        select: { status: true },
        disableErrors: true,
        overrideAccess: true,
        req,
      })
    : null
  if (company?.status !== 'approved') {
    throw new APIError('Project: approve the company before publishing its project', 403)
  }
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
