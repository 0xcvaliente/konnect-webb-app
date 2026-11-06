import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import nodemailer from 'nodemailer'
import type { EmailAdapter } from 'payload'

/**
 * A plain-text version of an HTML email, for messages Payload builds itself (verification and
 * reset emails sent through its own endpoints), which pass HTML only. Links keep their address.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(
      /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, '').trim()
        return text && text !== href ? `${text}: ${href}` : href
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|div|li)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Email goes out over SMTP: Mailjet in production, Mailpit on a developer's machine
 * (`docker compose up -d mailpit`, inbox at http://localhost:8025).
 *
 * Without SMTP_HOST (tests and CI) messages are built but sent nowhere, and nothing about them is
 * logged: no addresses, no bodies, no links. Never log an email's content, it can hold a sign-in
 * link or personal data.
 */
export async function emailAdapter(): Promise<EmailAdapter> {
  const production = process.env.NODE_ENV === 'production'
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT ?? 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASSWORD

  const base = await nodemailerAdapter({
    defaultFromAddress: process.env.EMAIL_FROM ?? 'no-reply@konnected.no',
    defaultFromName: 'Konnected',
    // Do not open an SMTP connection when the app starts.
    skipVerify: true,
    transport: host
      ? nodemailer.createTransport({
          host,
          port,
          // Port 465 is TLS from the start. On 587 production refuses to send without STARTTLS,
          // so the password and the links in the email are never sent in clear text. Mailpit
          // (port 1025, local only) has no TLS.
          secure: port === 465,
          requireTLS: production && port !== 465,
          ...(user && pass ? { auth: { user, pass } } : {}),
        })
      : production
        ? // A production server without SMTP must fail loudly, not drop every email in silence.
          nodemailer.createTransport({
            name: 'smtp-not-configured',
            version: '1',
            send: (_mail, done) => done(new Error('SMTP_HOST is not set'), undefined as never),
          })
        : nodemailer.createTransport({ jsonTransport: true }),
  })

  // Every email gets a plain-text part next to the HTML.
  return (args) => {
    const adapter = base(args)
    return {
      ...adapter,
      sendEmail: (message) =>
        adapter.sendEmail(
          message.text || typeof message.html !== 'string'
            ? message
            : { ...message, text: htmlToText(message.html) },
        ),
    }
  }
}
