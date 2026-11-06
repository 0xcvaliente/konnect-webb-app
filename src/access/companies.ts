import type { PayloadRequest } from 'payload'

import { companyIdOf } from './roles'

/**
 * The company of the signed-in company user, but only once Konnected approved it. Until then
 * nothing in the company area works except the company profile itself (Kanban card "Company
 * registration"): no projects, not even drafts, and no brief files.
 *
 * Bypass: the status is read with `overrideAccess: true` so this works the same in every access
 * function. Only the status is used.
 */
export async function approvedCompanyId(req: PayloadRequest): Promise<number | undefined> {
  const companyId = companyIdOf(req.user)
  if (!companyId) return undefined
  const company = await req.payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return company?.status === 'approved' ? companyId : undefined
}
