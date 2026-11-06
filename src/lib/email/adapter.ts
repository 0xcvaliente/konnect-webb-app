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
          // Port 465 is TLS from the start; 587 and Mailpit's 1025 upgrade with STARTTLS or not at all.
          secure: port === 465,
          ...(user && pass ? { auth: { user, pass } } : {}),
        })
      : nodemailer.createTransport({ jsonTransport: true }),
  })
}
