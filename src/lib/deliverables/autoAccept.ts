import type { Payload, PayloadRequest } from 'payload'

import type { DeliverableContext } from '@/collections/Deliverables'

import { FIX_WINDOW_DAYS, fixWindowOver } from './fields'

/**
 * Record that released work counts as accepted once the 7 days for fixes are over (owner rule):
 * the company neither accepted it nor asked for a fix. The rule itself holds without this (the
 * company cannot ask for a fix after the 7 days, and the pages show the work as accepted); this
 * writes it down, so the activity log, the team's queue and both parties' emails follow.
 *
 * Bypass: a scheduled job has no user, so it updates with `overrideAccess: true` and the
 * server-only `autoAccept` context. The Deliverables hook accepts that only for a released
 * hand-in whose 7 days are over. Returns how many were accepted.
 */
export async function acceptDueDeliverables(
  payload: Payload,
  req?: Partial<PayloadRequest>,
  now: Date = new Date(),
): Promise<number> {
  // Only rows released more than 7 full days ago can be due; the hook checks the Oslo days.
  const before = new Date(now.getTime() - FIX_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const due = await payload.find({
    collection: 'deliverables',
    where: { and: [{ status: { equals: 'released' } }, { releasedAt: { less_than: before } }] },
    depth: 0,
    pagination: false,
    select: { releasedAt: true },
    overrideAccess: true,
    req,
  })
  let accepted = 0
  for (const doc of due.docs) {
    if (!doc.releasedAt || !fixWindowOver(doc.releasedAt, now)) continue
    try {
      await payload.update({
        collection: 'deliverables',
        id: doc.id,
        data: { status: 'accepted' },
        overrideAccess: true,
        context: { autoAccept: true } satisfies DeliverableContext,
      })
      accepted += 1
    } catch {
      // Someone acted on it meanwhile (the company accepted or asked for a fix). Nothing to do.
    }
  }
  return accepted
}
