import { nodemailerAdapter } from '@payloadcms/email-nodemailer'
import nodemailer from 'nodemailer'

/**
 * Email goes out over SMTP: Mailjet in production, Mailpit on a developer's machine
 * (`docker compose up -d mailpit`, inbox at http://localhost:8025).
 *
 * Without SMTP_HOST (tests and CI) messages are built but sent nowhere, and nothing about them is
 * logged: no addresses, no bodies, no links. Never log an email's content, it can hold a sign-in
 * link or personal data.
 */
export function emailAdapter() {
  const production = process.env.NODE_ENV === 'production'
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT ?? 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASSWORD

  return nodemailerAdapter({
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
}
