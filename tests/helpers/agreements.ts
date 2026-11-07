import type { Payload } from 'payload'

import type { AgreementKind } from '@/lib/agreements/fields'
import { AGREEMENTS_QUEUE, type AgreementInput, requestAgreement } from '@/lib/agreements/generate'
import { signAgreement } from '@/lib/agreements/sign'
import type { Agreement, AgreementTemplate, User } from '@/payload-types'

import { companyTemplateDocx, studentTemplateDocx } from './docx'
import { fileOf } from './files'

const asUser = (user: User) => ({ ...user, collection: 'users' as const })

/** Upload a template as the admin, through the collection's rules. */
export async function uploadTemplate(
  payload: Payload,
  admin: User,
  kind: AgreementKind,
  docx: Buffer,
  name = `${kind}-agreement.docx`,
): Promise<AgreementTemplate> {
  return payload.create({
    collection: 'agreement-templates',
    data: { kind } as never,
    file: fileOf(
      docx,
      name,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ),
    user: asUser(admin),
    overrideAccess: false,
  })
}

/** Upload and publish one template of each kind (the test templates in helpers/docx.ts). */
export async function publishTestTemplates(payload: Payload, admin: User) {
  const out: Record<AgreementKind, AgreementTemplate> = {} as never
  for (const [kind, docx] of [
    ['company', companyTemplateDocx()],
    ['student', studentTemplateDocx()],
  ] as const) {
    const draft = await uploadTemplate(payload, admin, kind, docx)
    out[kind] = await payload.update({
      collection: 'agreement-templates',
      id: draft.id,
      data: { status: 'published' },
      user: asUser(admin),
      overrideAccess: false,
    })
  }
  return out
}

/** Run every agreement job that is due (making PDFs, then the emails they queue). */
export async function runAgreementJobs(payload: Payload): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const result = await payload.jobs.run({ queue: AGREEMENTS_QUEUE, limit: 50 })
    if (!result || (result as { noJobsRemaining?: boolean }).noJobsRemaining) break
  }
}

/** Ask for an agreement as the admin and run the job that makes its PDF. */
export async function makeAgreement(
  payload: Payload,
  admin: User,
  input: AgreementInput,
): Promise<Agreement> {
  const result = await requestAgreement(payload, admin, input)
  if (!result.ok) throw new Error(`Could not make the agreement: ${result.error}`)
  await runAgreementJobs(payload)
  return (await payload.findByID({
    collection: 'agreements',
    id: result.id,
    depth: 0,
    overrideAccess: true,
  })) as Agreement
}

/** Sign as `user` with everything ticked and the right fingerprint. */
export async function signAs(
  payload: Payload,
  user: User,
  agreement: Pick<Agreement, 'id' | 'unsignedSha256'>,
  name = 'Signer Name',
) {
  return signAgreement(
    payload,
    user,
    {
      agreementId: agreement.id,
      typedName: name,
      agree: true,
      authority: true,
      documentSha256: agreement.unsignedSha256 ?? '',
    },
    'password',
  )
}

/**
 * A fully signed agreement: made from the published template, signed by the party, then by
 * Konnected, with the emails sent. The way every real agreement gets signed.
 */
export async function signedAgreement(
  payload: Payload,
  admin: User,
  party: User,
  input: AgreementInput,
): Promise<Agreement> {
  const agreement = await makeAgreement(payload, admin, input)
  const first = await signAs(payload, party, agreement, 'Party Signer')
  if (!first.ok) throw new Error(`The party could not sign: ${first.error}`)
  const last = await signAs(payload, admin, agreement, 'Konnected Signer')
  if (!last.ok) throw new Error(`Konnected could not sign: ${last.error}`)
  await runAgreementJobs(payload)
  return (await payload.findByID({
    collection: 'agreements',
    id: agreement.id,
    depth: 0,
    overrideAccess: true,
  })) as Agreement
}
