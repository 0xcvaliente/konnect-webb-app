import type { Payload } from 'payload'

import {
  type AccessUser,
  companyIdOf,
  isAdmin,
  isCompany,
  isStudent,
  relationId,
} from '@/access/roles'
import type { Agreement, AgreementPdf, Company, Signature } from '@/payload-types'

import { NAME_MAX, type SignatureParty, type SignInMethodUsed, TICK_TEXT_VERSION } from './fields'
import { AGREEMENTS_QUEUE, inAgreementTransaction, lockAgreement } from './generate'
import { buildSignedPdf, sha256 } from './pdf'
import { readStoredFile } from './storage'

/**
 * Signing (konnected-agreements, Signing flow). The signer reads the PDF, ticks "I have read and
 * agree" (a company also ticks that it may sign for the company), types their full name and signs.
 * The server checks everything again, in one transaction:
 *
 * - the user may read this agreement (the collection's own read rule, as that user);
 * - it is their turn: the company or the student while the agreement waits for its party,
 *   Konnected (an admin) only after that, last;
 * - the box is ticked, the name is not empty, and the fingerprint the page showed equals the
 *   stored one, which still matches the stored PDF on disk;
 *
 * then writes the Signature and moves the agreement. One signature per party (unique index), so
 * two tabs or two clicks cannot sign twice. When Konnected's signature completes the agreement,
 * the signed PDF (with a signing page) is built and stored with its SHA-256, and the email with
 * the PDF to both parties is queued in the same transaction.
 */

export type SignError =
  | 'forbidden'
  | 'not_found'
  | 'not_your_turn'
  | 'already_signed'
  | 'not_ticked'
  | 'authority_not_ticked'
  | 'name_required'
  | 'name_too_long'
  | 'document_changed'
  | 'generic'

export type SignResult = { ok: true; status: Agreement['status'] } | { ok: false; error: SignError }

export type SignInput = {
  agreementId: number
  typedName: string
  /** "I have read and agree". */
  agree: boolean
  /** Company only: "I may sign for <company>". */
  authority?: boolean
  /** The fingerprint shown on the page the signer read. */
  documentSha256: string
}

/** Collapse spaces; the name is stored as typed otherwise. */
export const cleanName = (value: string): string => value.replace(/\s+/g, ' ').trim()

const partyOf = (user: AccessUser): SignatureParty | null =>
  isAdmin(user) ? 'konnected' : isCompany(user) ? 'company' : isStudent(user) ? 'student' : null

export async function signAgreement(
  payload: Payload,
  user: AccessUser | null,
  input: SignInput,
  method: SignInMethodUsed,
): Promise<SignResult> {
  if (!user) return { ok: false, error: 'forbidden' }
  const party = partyOf(user)
  if (!party) return { ok: false, error: 'forbidden' }

  const typedName = cleanName(input.typedName ?? '')
  if (!input.agree) return { ok: false, error: 'not_ticked' }
  if (party === 'company' && !input.authority) return { ok: false, error: 'authority_not_ticked' }
  if (typedName.length < 2) return { ok: false, error: 'name_required' }
  if (typedName.length > NAME_MAX) return { ok: false, error: 'name_too_long' }
  const shown = String(input.documentSha256 ?? '').toLowerCase()

  try {
    return await inAgreementTransaction(payload, user, async (req): Promise<SignResult> => {
      // Read as the signer, with access control on: someone else's agreement is "not found".
      const agreement = (await req.payload.findByID({
        collection: 'agreements',
        id: input.agreementId,
        depth: 0,
        user: { collection: 'users', ...user } as never,
        overrideAccess: false,
        disableErrors: true,
        req,
      })) as Agreement | null
      if (!agreement) return { ok: false, error: 'not_found' }

      // Hold the row until this transaction ends, so the status read next is the one written
      // over: a withdrawal at the same moment waits, or goes first and this sees `void`.
      await lockAgreement(req, agreement.id)
      // Bypass: the full row, including the admin-only fields the signer cannot read.
      const full = (await req.payload.findByID({
        collection: 'agreements',
        id: agreement.id,
        depth: 0,
        overrideAccess: true,
        req,
      })) as Agreement

      const expected: SignatureParty | null =
        full.status === 'awaiting_party'
          ? full.kind
          : full.status === 'awaiting_konnected'
            ? 'konnected'
            : null
      if (full.status === 'signed') return { ok: false, error: 'already_signed' }
      if (expected !== party) return { ok: false, error: 'not_your_turn' }
      // The company that signs is the agreement's own company (read rule above), the student the
      // agreement's own student. Checked again here so the rule never rests on one place.
      if (party === 'company' && companyIdOf(user) !== relationId(full.company)) {
        return { ok: false, error: 'forbidden' }
      }

      // The PDF the signer read: the fingerprint they saw, the stored one, and the file itself.
      const pdfDoc = (await req.payload.findByID({
        collection: 'agreement-pdfs',
        id: relationId(full.unsignedPdf)!,
        depth: 0,
        overrideAccess: true,
        req,
      })) as AgreementPdf
      const unsigned = await readStoredFile('agreement-pdfs', pdfDoc.filename)
      if (
        !full.unsignedSha256 ||
        shown !== full.unsignedSha256 ||
        sha256(unsigned) !== full.unsignedSha256
      ) {
        return { ok: false, error: 'document_changed' }
      }

      const signedAt = new Date().toISOString()
      await req.payload.create({
        collection: 'signatures',
        data: {
          agreement: full.id,
          signer: user.id,
          party,
          typedName,
          ticked: true,
          tickTextVersion: TICK_TEXT_VERSION,
          documentSha256: full.unsignedSha256,
          signedAt,
          signInMethod: method,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })

      if (party !== 'konnected') {
        await req.payload.update({
          collection: 'agreements',
          id: full.id,
          data: { status: 'awaiting_konnected', partySignedAt: signedAt },
          depth: 0,
          overrideAccess: true,
          req,
        })
        return { ok: true, status: 'awaiting_konnected' }
      }

      // Konnected signs last: build the signed PDF with the signing page.
      const signatures = await req.payload.find({
        collection: 'signatures',
        where: { agreement: { equals: full.id } },
        sort: 'signedAt',
        depth: 0,
        pagination: false,
        overrideAccess: true,
        req,
      })
      const company = full.company
        ? ((await req.payload.findByID({
            collection: 'companies',
            id: relationId(full.company)!,
            depth: 0,
            select: { name: true },
            overrideAccess: true,
            req,
          })) as Pick<Company, 'name'>)
        : null
      const project = await req.payload.findByID({
        collection: 'projects',
        id: relationId(full.project)!,
        depth: 0,
        select: { title: true },
        overrideAccess: true,
        req,
      })
      const signedPdf = await buildSignedPdf(unsigned, {
        reference: full.reference,
        kind: full.kind,
        projectTitle: project.title,
        unsignedSha256: full.unsignedSha256,
        completedAt: signedAt,
        signatures: (signatures.docs as Signature[]).map((s) => ({
          party: s.party,
          partyName: s.party === 'company' ? company?.name : null,
          typedName: s.typedName,
          signedAt: s.signedAt,
          method: s.signInMethod,
        })),
      })
      const signedHash = sha256(signedPdf)
      const file = await req.payload.create({
        collection: 'agreement-pdfs',
        data: { agreement: full.id, variant: 'signed', sha256: signedHash },
        file: {
          data: signedPdf,
          name: `${full.reference}-signed.pdf`,
          mimetype: 'application/pdf',
          size: signedPdf.length,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      await req.payload.update({
        collection: 'agreements',
        id: full.id,
        data: {
          status: 'signed',
          signedPdf: file.id,
          signedSha256: signedHash,
          completedAt: signedAt,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      await req.payload.jobs.queue({
        task: 'sendAgreementEmail',
        input: { agreementId: full.id, email: 'signed' },
        queue: AGREEMENTS_QUEUE,
        req,
      })
      return { ok: true, status: 'signed' }
    })
  } catch (error) {
    // A second signature for the same party at the same moment: the unique index refused it.
    // Check that this is what happened (the other signature is now there) before saying so.
    const { totalDocs } = await payload.count({
      collection: 'signatures',
      where: {
        and: [{ agreement: { equals: input.agreementId } }, { party: { equals: party } }],
      },
      overrideAccess: true,
    })
    if (totalDocs > 0) return { ok: false, error: 'already_signed' }
    throw error
  }
}
