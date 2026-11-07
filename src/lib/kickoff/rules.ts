import { APIError, type PayloadRequest } from 'payload'

import type { KickoffError } from './fields'

/**
 * Server rules of the kick-off (lib/kickoff/fields.ts), shared by the Matches hook and the
 * agreement code. Only yes or no leaves here.
 */

/** Context the kick-off save sets for the Matches hook: the match whose kick-off is saved. */
export type KickoffContext = { kickoffSave?: number }

export const kickoffError = (code: KickoffError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

/**
 * Is a student agreement made from this match in use (being made, waiting for a signature, or
 * signed)? A withdrawn or failed one is not. Bypass: the server reads the agreement's key, whoever
 * acts; only a yes or no leaves here.
 */
export async function studentAgreementInUse(
  req: PayloadRequest,
  matchId: number,
): Promise<boolean> {
  const { totalDocs } = await req.payload.count({
    collection: 'agreements',
    where: { activeKey: { equals: `student:${matchId}` } },
    overrideAccess: true,
    req,
  })
  return totalDocs > 0
}
