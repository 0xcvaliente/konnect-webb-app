import type { Payload } from 'payload'

import { type EmailLocale, emailLocale, render, type RenderedEmail } from '@/lib/email/templates'
import en from '@/messages/en.json'
import no from '@/messages/no.json'

import type { AgreementKind } from './fields'
import { groupedHash } from './pdf'

/**
 * The agreement emails (konnected-email): "an agreement waits for you" and "the signed agreement",
 * with the signed PDF attached, in the recipient's language. Each says what happened and links to
 * the app; the project title is the only detail. A company is never sent a student agreement.
 *
 * Logs only the email type, the user id and the result. Never the address, the body or the file.
 */

type Messages = (typeof en)['AgreementEmail']
const MESSAGES: Record<EmailLocale, Messages> = { en: en.AgreementEmail, no: no.AgreementEmail }

const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_m, key: string) => values[key] ?? '')

/** "Your agreement is ready to sign." */
export function agreementToSignEmail(
  locale: EmailLocale,
  kind: AgreementKind,
  title: string,
  href: string,
): RenderedEmail {
  const m = MESSAGES[locale].toSign
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [fill(m[kind], { title }), m.how],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: (locale === 'no' ? no : en).Email.common.accountFooter,
  })
}

/** "Your agreement is signed": the signed PDF is attached; the fingerprint identifies it. */
export function agreementSignedEmail(
  locale: EmailLocale,
  title: string,
  reference: string,
  fingerprint: string,
  href: string,
): RenderedEmail {
  const m = MESSAGES[locale].signed
  return render({
    locale,
    subject: fill(m.subject, { reference }),
    heading: m.heading,
    paragraphs: [
      fill(m.body, { title, reference }),
      m.attached,
      fill(m.fingerprint, { fingerprint: groupedHash(fingerprint) }),
    ],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: (locale === 'no' ? no : en).Email.common.accountFooter,
  })
}

export type AgreementEmailType = 'agreement_to_sign' | 'agreement_signed'

/**
 * Send one agreement email. Unlike the sign-in emails it is sent from a background job, so a
 * failure throws and the job tries again; the log line holds no address or content.
 */
export async function sendAgreementEmail(
  payload: Payload,
  message: {
    to: string
    email: RenderedEmail
    type: AgreementEmailType
    userId: number
    attachment?: { filename: string; content: Buffer }
  },
): Promise<void> {
  try {
    await payload.email.sendEmail({
      from: `"${payload.email.defaultFromName}" <${payload.email.defaultFromAddress}>`,
      to: message.to,
      subject: message.email.subject,
      html: message.email.html,
      text: message.email.text,
      ...(message.attachment
        ? {
            attachments: [
              {
                filename: message.attachment.filename,
                content: message.attachment.content,
                contentType: 'application/pdf',
              },
            ],
          }
        : {}),
    })
    payload.logger.info({ msg: 'Email sent', type: message.type, userId: message.userId })
  } catch (error) {
    payload.logger.error({
      msg: 'Email could not be sent',
      type: message.type,
      userId: message.userId,
      reason: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}

export { emailLocale }
