import type { Payload } from 'payload'

import { relationId } from '@/access/roles'
import type { Agreement, AgreementPdf, Signature, User } from '@/payload-types'

/**
 * What the agreement pages show, read as the signed-in user with access control on: an agreement
 * the user may not read is simply not there (a company never gets a student agreement).
 */

type SessionUser = User & { collection: 'users' }

export type AgreementView = {
  agreement: Agreement
  unsigned: AgreementPdf | null
  signed: AgreementPdf | null
  signatures: Signature[]
}

const pdf = async (payload: Payload, user: SessionUser, id: number | undefined) =>
  id
    ? ((await payload.findByID({
        collection: 'agreement-pdfs',
        id,
        depth: 0,
        user,
        overrideAccess: false,
        disableErrors: true,
      })) as AgreementPdf | null)
    : null

export async function loadAgreementView(
  payload: Payload,
  user: SessionUser,
  id: number,
): Promise<AgreementView | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const agreement = (await payload.findByID({
    collection: 'agreements',
    id,
    depth: 0,
    user,
    overrideAccess: false,
    disableErrors: true,
  })) as Agreement | null
  if (!agreement) return null
  const signatures = await payload.find({
    collection: 'signatures',
    where: { agreement: { equals: id } },
    sort: 'signedAt',
    depth: 0,
    pagination: false,
    user,
    overrideAccess: false,
  })
  return {
    agreement,
    unsigned: await pdf(payload, user, relationId(agreement.unsignedPdf)),
    signed: await pdf(payload, user, relationId(agreement.signedPdf)),
    signatures: signatures.docs as Signature[],
  }
}

/** The user's own agreements, newest first. */
export async function listOwnAgreements(payload: Payload, user: SessionUser) {
  const found = await payload.find({
    collection: 'agreements',
    sort: '-createdAt',
    depth: 0,
    limit: 100,
    user,
    overrideAccess: false,
  })
  return found.docs as Agreement[]
}
