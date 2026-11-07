import { APIError, type PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { lockRow } from '@/lib/db/locks'

import { type DeliveryItem, deliveryState, workSettled } from './fields'

/**
 * Konnected closes a delivered project only when the work on it is settled (workSettled): no
 * hand-in waits for Konnected, no fix round is open, and the newest release is accepted or its 7
 * days are over. Otherwise the company could still ask for its fix on a closed project, or the
 * student would be left with work they can never hand in. The team can accept a release for the
 * company first, to close sooner.
 *
 * Locks the project first (lock order: project, then the work on it), so a release or a fix
 * request on the same project runs before or after the close, never between the check and the
 * save; both lock the project too (Deliverables hook).
 *
 * Bypass: the server reads the project's matches and hand-ins whatever the acting user may read,
 * only to apply the rule. Only a yes or no leaves here.
 */
export async function assertWorkSettled(
  req: PayloadRequest,
  projectId: number | undefined,
): Promise<void> {
  if (!projectId) return
  await lockRow(req, 'projects', projectId)
  const matches = await req.payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    depth: 0,
    pagination: false,
    select: { project: true },
    overrideAccess: true,
    req,
  })
  if (!matches.docs.length) return
  const items = await req.payload.find({
    collection: 'deliverables',
    where: { match: { in: matches.docs.map((m) => m.id) } },
    depth: 0,
    pagination: false,
    select: { match: true, status: true, createdAt: true, releasedAt: true, fixRequestedAt: true },
    overrideAccess: true,
    req,
  })
  for (const match of matches.docs) {
    const mine = items.docs.filter((d) => relationId(d.match as number) === match.id)
    if (!workSettled(deliveryState(mine as DeliveryItem[], 'delivered'))) {
      throw new APIError(
        'The work on this project is still open: a hand-in waits, a fix is asked, or the company can still ask for one. Accept the work for the company, or wait until it is settled, then close.',
        409,
        { code: 'work_open' },
        true,
      )
    }
  }
}
