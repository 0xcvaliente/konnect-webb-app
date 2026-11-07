import type { PayloadRequest } from 'payload'

import type { Company } from '@/payload-types'

import { companyIdOf } from './roles'

/**
 * The status of the signed-in company user's company, or undefined for anyone else.
 *
 * Bypass: the status is read with `overrideAccess: true` so this works the same in every access
 * function. Only the status is used.
 */
async function ownCompanyStatus(
  req: PayloadRequest,
): Promise<{ companyId: number; status: Company['status'] } | undefined> {
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
  return company ? { companyId, status: company.status } : undefined
}

/** The company of the signed-in company user, but only once Konnected approved it. */
export async function approvedCompanyId(req: PayloadRequest): Promise<number | undefined> {
  const own = await ownCompanyStatus(req)
  return own?.status === 'approved' ? own.companyId : undefined
}

/**
 * The company of the signed-in company user while it is pending or approved. A pending company
 * may already write draft projects and upload their brief files (owner decision); only an approved
 * company sends a project for review (see the Projects hook). A rejected company writes nothing.
 */
export async function draftingCompanyId(req: PayloadRequest): Promise<number | undefined> {
  const own = await ownCompanyStatus(req)
  return own && (own.status === 'pending' || own.status === 'approved') ? own.companyId : undefined
}
