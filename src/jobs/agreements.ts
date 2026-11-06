import type { Payload, TaskConfig } from 'payload'

import { relationId } from '@/access/roles'
import {
  agreementSignedEmail,
  agreementToSignEmail,
  emailLocale,
  sendAgreementEmail,
} from '@/lib/agreements/emails'
import {
  AGREEMENTS_QUEUE,
  generateAgreementPdf,
  inAgreementTransaction,
} from '@/lib/agreements/generate'
import { readStoredFile } from '@/lib/agreements/storage'
import type { Agreement, AgreementPdf, User } from '@/payload-types'

export { AGREEMENTS_QUEUE }

/** Tries for one job: the first run plus this many retries, 30 seconds apart. */
const RETRIES = 3

/**
 * Make an agreement's PDF: fill the template and convert it with Gotenberg (lib/agreements).
 * Converter problems are retried; on the last try the agreement is marked failed for the team.
 * The output holds the outcome only.
 */
export const generateAgreementTask: TaskConfig<{
  input: { agreementId: number }
  output: { outcome: string }
}> = {
  slug: 'generateAgreement',
  label: 'Make an agreement PDF',
  retries: { attempts: RETRIES, backoff: { type: 'fixed', delay: 30_000 } },
  inputSchema: [{ name: 'agreementId', type: 'number', required: true }],
  outputSchema: [{ name: 'outcome', type: 'text', required: true }],
  handler: async ({ input, job, req }) => {
    const outcome = await generateAgreementPdf(req.payload, input.agreementId, {
      lastAttempt: (job.totalTried ?? 0) >= RETRIES,
    })
    return { output: { outcome } }
  },
}

/** The user who signs for the party: the company's one user, or the student. */
async function partyUser(payload: Payload, agreement: Agreement): Promise<User | null> {
  if (agreement.kind === 'company') {
    const found = await payload.find({
      collection: 'users',
      where: {
        and: [
          { company: { equals: relationId(agreement.company) } },
          { role: { equals: 'company' } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
    return (found.docs[0] as User | undefined) ?? null
  }
  const profile = await payload.findByID({
    collection: 'student-profiles',
    id: relationId(agreement.student)!,
    depth: 0,
    select: { user: true },
    overrideAccess: true,
    disableErrors: true,
  })
  const userId = relationId(profile?.user)
  if (!userId) return null
  return (await payload.findByID({
    collection: 'users',
    id: userId,
    depth: 0,
    overrideAccess: true,
    disableErrors: true,
  })) as User | null
}

const appUrl = () => (process.env.APP_URL ?? '').replace(/\/+$/, '')

/**
 * The agreement emails, sent after the change is committed:
 * - `to_sign`: the agreement waits for the company or the student;
 * - `signed`: Konnected signed last; the signed PDF goes to the party and to the Konnected team
 *   member who signed, then `emailedAt` is recorded.
 *
 * Bypass: the server reads the agreement, the recipients and the file with `overrideAccess: true`
 * (no user runs a job). Recipients come from the agreement itself, never from input.
 */
export const sendAgreementEmailTask: TaskConfig<{
  input: { agreementId: number; email: 'to_sign' | 'signed' }
  output: { sent: number }
}> = {
  slug: 'sendAgreementEmail',
  label: 'Send an agreement email',
  retries: { attempts: RETRIES, backoff: { type: 'fixed', delay: 30_000 } },
  inputSchema: [
    { name: 'agreementId', type: 'number', required: true },
    { name: 'email', type: 'select', options: ['to_sign', 'signed'], required: true },
  ],
  outputSchema: [{ name: 'sent', type: 'number', required: true }],
  handler: async ({ input, req }) => {
    const { payload } = req
    const agreement = (await payload.findByID({
      collection: 'agreements',
      id: input.agreementId,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
    })) as Agreement | null
    if (!agreement) return { output: { sent: 0 } }
    const project = await payload.findByID({
      collection: 'projects',
      id: relationId(agreement.project)!,
      depth: 0,
      select: { title: true },
      overrideAccess: true,
    })
    const party = await partyUser(payload, agreement)
    const area = agreement.kind === 'company' ? 'company' : 'student'

    if (input.email === 'to_sign') {
      if (agreement.status !== 'awaiting_party' || !party) return { output: { sent: 0 } }
      const locale = emailLocale(party.language)
      await sendAgreementEmail(payload, {
        to: party.email,
        type: 'agreement_to_sign',
        userId: party.id,
        email: agreementToSignEmail(
          locale,
          agreement.kind,
          project.title,
          `${appUrl()}/${locale}/${area}/agreements/${agreement.id}`,
        ),
      })
      return { output: { sent: 1 } }
    }

    if (agreement.status !== 'signed' || agreement.emailedAt) return { output: { sent: 0 } }
    const pdfDoc = (await payload.findByID({
      collection: 'agreement-pdfs',
      id: relationId(agreement.signedPdf)!,
      depth: 0,
      overrideAccess: true,
    })) as AgreementPdf
    const content = await readStoredFile('agreement-pdfs', pdfDoc.filename)
    const konnected = await payload.find({
      collection: 'signatures',
      where: {
        and: [{ agreement: { equals: agreement.id } }, { party: { equals: 'konnected' } }],
      },
      limit: 1,
      depth: 1,
      overrideAccess: true,
    })
    const teamSigner = konnected.docs[0]?.signer as User | number | undefined
    const recipients = [
      party ? { user: party, area } : null,
      typeof teamSigner === 'object' ? { user: teamSigner, area: 'team' } : null,
    ].filter(Boolean) as { user: User; area: string }[]

    for (const { user, area: where } of recipients) {
      const locale = emailLocale(user.language)
      await sendAgreementEmail(payload, {
        to: user.email,
        type: 'agreement_signed',
        userId: user.id,
        attachment: { filename: `Konnected ${agreement.reference}.pdf`, content },
        email: agreementSignedEmail(
          locale,
          project.title,
          agreement.reference,
          agreement.signedSha256 ?? '',
          `${appUrl()}/${locale}/${where}/agreements/${agreement.id}`,
        ),
      })
    }
    await inAgreementTransaction(payload, null, async (tx) => {
      await tx.payload.update({
        collection: 'agreements',
        id: agreement.id,
        data: { emailedAt: new Date().toISOString() },
        depth: 0,
        overrideAccess: true,
        req: tx,
      })
    })
    return { output: { sent: recipients.length } }
  },
}
