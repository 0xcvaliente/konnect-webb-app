import { randomBytes } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import {
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { agreementServerContext } from '@/access/agreements'
import { type AccessUser, isAdmin, relationId } from '@/access/roles'
import type { Agreement, AgreementTemplate } from '@/payload-types'

import { fillTemplate, MissingValueError } from './docx'
import type { AgreementKind } from './fields'
import { convertDocxToPdf } from './gotenberg'
import { sha256 } from './pdf'
import { readStoredFile } from './storage'
import { agreementValues, loadSource, missingFields } from './values'

/**
 * Making agreements: the team asks for one (requestAgreement), a background job fills the
 * template and converts it to a PDF (generateAgreementPdf), and the team can withdraw one that is
 * not complete (voidAgreement) and make a new one that replaces it.
 *
 * Writes use `overrideAccess: true` with the server-write flag: agreements, their PDFs and
 * signatures are closed to every API, and these functions are the only writers. Each checks who
 * asks first. Nothing here logs values from the agreement.
 */

export const AGREEMENTS_QUEUE = 'agreements'

export type AgreementInput =
  { kind: 'company'; projectId: number } | { kind: 'student'; matchId: number }

export type RequestError =
  | 'forbidden'
  | 'not_found'
  | 'wrong_status'
  | 'no_template'
  | 'missing_values'
  | 'already_exists'
  /** A student agreement is made after the kick-off is recorded (lib/kickoff). */
  | 'no_kickoff'
  | 'generic'

export type RequestResult =
  { ok: true; id: number } | { ok: false; error: RequestError; fields?: string[] }

/** Run `fn` in one database transaction, as `user`, with the server-write flag set. */
export async function inAgreementTransaction<T>(
  payload: Payload,
  user: (AccessUser & { collection?: 'users' }) | null,
  fn: (req: PayloadRequest) => Promise<T>,
): Promise<T> {
  const req = await createLocalReq(
    {
      user: (user ? { collection: 'users', ...user } : undefined) as never,
      context: { ...agreementServerContext },
    },
    payload,
  )
  await initTransaction(req)
  try {
    const result = await fn(req)
    await commitTransaction(req)
    return result
  } catch (error) {
    await killTransaction(req)
    throw error
  }
}

/**
 * Lock the agreement's row until `req`'s transaction ends (`SELECT ... FOR UPDATE`). Call it
 * before reading the status a write depends on: a withdrawal (or another signature) waits for this
 * transaction, or this one waits for it and then reads its result. Payload takes no row locks.
 */
export async function lockAgreement(req: PayloadRequest, agreementId: number): Promise<void> {
  const id = req.transactionID ? await req.transactionID : undefined
  const tx = id === undefined ? undefined : req.payload.db.sessions?.[id]
  if (!tx) throw new Error('lockAgreement needs an open transaction')
  await (tx.db as { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }).execute(
    sql`SELECT 1 FROM "agreements" WHERE "id" = ${agreementId} FOR UPDATE`,
  )
}

const activeKeyOf = (input: AgreementInput) =>
  input.kind === 'company' ? `company:${input.projectId}` : `student:${input.matchId}`

/** The published template of a kind, or null. */
export async function publishedTemplate(
  req: PayloadRequest,
  kind: AgreementKind,
): Promise<AgreementTemplate | null> {
  const found = await req.payload.find({
    collection: 'agreement-templates',
    where: { and: [{ kind: { equals: kind } }, { status: { equals: 'published' } }] },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    req,
  })
  return found.docs[0] ?? null
}

/**
 * Ask for a new agreement (admins only): the company agreement of an approved project, or the
 * student agreement of a matched project once its kick-off is recorded. Checks that a published template exists, that every
 * field it uses has a value, and that no agreement for the same project or match is in use, then
 * stores the agreement as `generating` and queues the job that makes the PDF.
 */
export async function requestAgreement(
  payload: Payload,
  user: AccessUser | null,
  input: AgreementInput,
  options: { replaces?: number } = {},
): Promise<RequestResult> {
  if (!isAdmin(user)) return { ok: false, error: 'forbidden' }
  try {
    return await inAgreementTransaction(payload, user, async (req): Promise<RequestResult> => {
      const source = await loadSource(req, input)
      if (!source) return { ok: false, error: 'not_found' }
      const wanted = input.kind === 'company' ? 'approved' : 'matched'
      if (source.project.status !== wanted) return { ok: false, error: 'wrong_status' }
      // The student agreement comes after the kick-off: it holds the dates agreed there.
      if (source.kind === 'student' && (source.match.endedAt || !source.match.kickoff?.recordedAt))
        return { ok: false, error: source.match.endedAt ? 'wrong_status' : 'no_kickoff' }

      const template = await publishedTemplate(req, input.kind)
      if (!template) return { ok: false, error: 'no_template' }

      const key = activeKeyOf(input)
      const { totalDocs } = await req.payload.count({
        collection: 'agreements',
        where: { activeKey: { equals: key } },
        overrideAccess: true,
        req,
      })
      if (totalDocs > 0) return { ok: false, error: 'already_exists' }

      const reference = `AGR-${randomBytes(4).toString('hex').toUpperCase()}`
      const fields = (template.fields as string[] | null) ?? []
      const all = agreementValues(source, { reference })
      const missing = missingFields(fields, all)
      if (missing.length) return { ok: false, error: 'missing_values', fields: missing }
      // Keep only the values the template uses.
      const values = Object.fromEntries(fields.map((f) => [f, all[f as keyof typeof all]]))

      const agreement = await req.payload.create({
        collection: 'agreements',
        data: {
          reference,
          kind: input.kind,
          title: source.project.title,
          status: 'generating',
          project: source.project.id,
          company: input.kind === 'company' ? source.company.id : null,
          match: source.kind === 'student' ? source.match.id : null,
          student: source.kind === 'student' ? source.student.id : null,
          template: template.id,
          templateVersion: template.version,
          values,
          requestedBy: user!.id,
          activeKey: key,
          replaces: options.replaces ?? null,
        },
        depth: 0,
        overrideAccess: true,
        req,
      })
      await req.payload.jobs.queue({
        task: 'generateAgreement',
        input: { agreementId: agreement.id },
        queue: AGREEMENTS_QUEUE,
        req,
      })
      return { ok: true, id: agreement.id }
    })
  } catch (error) {
    // Two requests at the same moment: the unique `activeKey` refused the second. Check that
    // this is what happened (the other agreement is now there) before saying so.
    const { totalDocs } = await payload.count({
      collection: 'agreements',
      where: { activeKey: { equals: activeKeyOf(input) } },
      overrideAccess: true,
    })
    if (totalDocs > 0) return { ok: false, error: 'already_exists' }
    throw error
  }
}

/**
 * Withdraw an agreement that is not complete (admins only), and optionally make a new one from
 * the current template and project details right away. The old one stays, marked `void`.
 */
export async function voidAgreement(
  payload: Payload,
  user: AccessUser | null,
  agreementId: number,
  { remake = false }: { remake?: boolean } = {},
): Promise<RequestResult> {
  if (!isAdmin(user)) return { ok: false, error: 'forbidden' }
  const agreement = await payload.findByID({
    collection: 'agreements',
    id: agreementId,
    depth: 0,
    user: { collection: 'users', ...user } as never,
    overrideAccess: false,
    disableErrors: true,
  })
  if (!agreement) return { ok: false, error: 'not_found' }
  try {
    // Through the API rules on purpose (no server flag): the collection decides what may be
    // withdrawn, the same as for a REST call.
    await payload.update({
      collection: 'agreements',
      id: agreementId,
      data: { status: 'void' },
      user: { collection: 'users', ...user } as never,
      overrideAccess: false,
    })
  } catch {
    return { ok: false, error: 'wrong_status' }
  }
  if (!remake) return { ok: true, id: agreementId }
  const input: AgreementInput =
    agreement.kind === 'company'
      ? { kind: 'company', projectId: relationId(agreement.project)! }
      : { kind: 'student', matchId: relationId(agreement.match)! }
  return requestAgreement(payload, user, input, { replaces: agreementId })
}

export type GenerateOutcome = 'done' | 'skipped' | 'failed'

/**
 * Mark an agreement that could not be made, with a code for the team. `skipped` when it is
 * no longer being made, for example withdrawn meanwhile.
 */
async function markFailed(
  payload: Payload,
  agreementId: number,
  failure: string,
): Promise<GenerateOutcome> {
  return inAgreementTransaction(payload, null, async (req) => {
    await lockAgreement(req, agreementId)
    const fresh = await req.payload.findByID({
      collection: 'agreements',
      id: agreementId,
      depth: 0,
      select: { status: true },
      overrideAccess: true,
      req,
    })
    if (fresh.status !== 'generating') return 'skipped'
    await req.payload.update({
      collection: 'agreements',
      id: agreementId,
      data: { status: 'failed', failure, activeKey: null },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return 'failed'
  })
}

/**
 * The background job's work: fill the template with the stored values, convert it to a PDF with
 * Gotenberg, store the PDF and its SHA-256, and move the agreement to `awaiting_party`. Then the
 * party gets an email. A template problem fails at once; a converter problem is retried by the
 * job, and fails on the last try.
 */
export async function generateAgreementPdf(
  payload: Payload,
  agreementId: number,
  {
    lastAttempt = true,
    convert = convertDocxToPdf,
  }: {
    lastAttempt?: boolean
    /** The converter. Gotenberg; the development seed passes a stand-in when none runs. */
    convert?: (docx: Buffer, name: string) => Promise<Buffer>
  } = {},
): Promise<GenerateOutcome> {
  const agreement = (await payload.findByID({
    collection: 'agreements',
    id: agreementId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as Agreement | null
  if (!agreement || agreement.status !== 'generating') return 'skipped'

  const template = (await payload.findByID({
    collection: 'agreement-templates',
    id: relationId(agreement.template)!,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as AgreementTemplate | null
  if (!template) return markFailed(payload, agreementId, 'template')

  let pdf: Buffer
  try {
    const docx = fillTemplate(
      await readStoredFile('agreement-templates', template.filename),
      (agreement.values ?? {}) as Record<string, string>,
    )
    pdf = await convert(docx, `${agreement.reference}.docx`)
  } catch (error) {
    if (error instanceof MissingValueError) {
      return markFailed(payload, agreementId, `missing_value:${error.field}`)
    }
    if ((error as Error).name === 'ConverterError' && !lastAttempt) throw error
    return markFailed(
      payload,
      agreementId,
      (error as Error).name === 'ConverterError' ? 'converter' : 'template',
    )
  }

  const hash = sha256(pdf)
  return inAgreementTransaction(payload, null, async (req): Promise<GenerateOutcome> => {
    // The team may have withdrawn it while the PDF was being made, or be withdrawing it now.
    await lockAgreement(req, agreementId)
    const fresh = await req.payload.findByID({
      collection: 'agreements',
      id: agreementId,
      depth: 0,
      select: { status: true },
      overrideAccess: true,
      req,
    })
    if (fresh.status !== 'generating') return 'skipped'
    const file = await req.payload.create({
      collection: 'agreement-pdfs',
      data: { agreement: agreementId, variant: 'unsigned', sha256: hash },
      file: {
        data: pdf,
        name: `${agreement.reference}.pdf`,
        mimetype: 'application/pdf',
        size: pdf.length,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    await req.payload.update({
      collection: 'agreements',
      id: agreementId,
      data: {
        status: 'awaiting_party',
        unsignedPdf: file.id,
        unsignedSha256: hash,
        generatedAt: new Date().toISOString(),
        failure: null,
      },
      depth: 0,
      overrideAccess: true,
      req,
    })
    await req.payload.jobs.queue({
      task: 'sendAgreementEmail',
      input: { agreementId, email: 'to_sign' },
      queue: AGREEMENTS_QUEUE,
      req,
    })
    return 'done'
  })
}
