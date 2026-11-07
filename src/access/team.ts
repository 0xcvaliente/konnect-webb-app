import { APIError, type CollectionBeforeChangeHook, type PayloadRequest } from 'payload'

import { lockRow } from '@/lib/db/locks'

import { isAdmin, relationId } from './roles'

/**
 * Who counts as on the Konnected team for owning work: a user with the admin role, on
 * ADMIN_EMAILS and not paused (the same people `listTeam` shows). Someone who left the team keeps
 * no work: hooks drop an owner copied from them, and Today shows their items in the shared pool.
 */

/** Is this user on the team now? Bypass: the server reads only the user's role, address and status. */
export async function isOnTeam(
  req: PayloadRequest,
  id: number | null | undefined,
): Promise<boolean> {
  if (!id) return false
  const user = await req.payload.findByID({
    collection: 'users',
    id,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return Boolean(user) && isAdmin(user)
}

/** The context flag `takeFromPool` sets on its update ("Take it"). */
export const POOL_TAKE = 'poolTake'

type PoolTable = 'companies' | 'projects' | 'student-profiles'

/**
 * "Take it" is first come, first served. Two team members pressing it at the same moment both
 * read the item as free, so the check runs again here: lock the row until this save commits, read
 * it again (a waiting save sees the first one's result) and refuse with 409 when someone on the
 * team owns it or took it already. Bypass: the server reads only the owner fields.
 */
export const refuseTakenOnPoolTake =
  (collection: PoolTable): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, operation, req, context }) => {
    if (operation !== 'update' || !context?.[POOL_TAKE] || !originalDoc?.id) return data
    await lockRow(req, collection, originalDoc.id)
    const stored = (await req.payload.findByID({
      collection,
      id: originalDoc.id,
      depth: 0,
      overrideAccess: true,
      req,
    })) as { takenBy?: unknown; teamOwner?: unknown; owner?: unknown }
    for (const key of ['takenBy', 'teamOwner', 'owner'] as const) {
      if (await isOnTeam(req, relationId(stored[key] as number))) {
        throw new APIError('Someone on the team already took this', 409)
      }
    }
    return data
  }
