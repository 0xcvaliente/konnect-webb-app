import { after } from 'next/server'
import type { Payload } from 'payload'

import type { RenderedEmail } from './templates'

/** Which email it was. The only detail about an email that may be logged, with the user id. */
export type EmailType =
  | 'verify'
  | 'magic_link'
  | 'account_exists'
  | 'team_no_link'
  | 'password_reset'
  | 'method_added'
  | 'account_paused'
  | 'account_reactivated'
  | 'role_changed'
  | 'project_submitted'
  | 'project_changes_requested'
  | 'project_rejected'
  | 'project_approved'
  | 'project_published'
  | 'company_approved'
  | 'company_rejected'
  | 'company_info_requested'
  | 'profile_reviewed'
  | 'profile_changes_requested'
  | 'application_received'
  | 'application_selected'
  | 'application_not_selected'
  | 'student_found'

/**
 * Send an email after the answer has gone back to the browser, so the answer takes the
 * same time whether an email was sent or not, and a slow or failing mail server never fails the
 * user's action. Outside a Next.js request (tests, scripts) it sends straight away.
 *
 * Logs only the email type, the user id (when there is an account) and the result. Never the
 * address, the subject, the body, the link or the token.
 */
export async function sendSignInEmail(
  payload: Payload,
  message: { to: string; email: RenderedEmail; type: EmailType; userId?: number },
): Promise<void> {
  const send = async () => {
    try {
      await payload.email.sendEmail({
        from: `"${payload.email.defaultFromName}" <${payload.email.defaultFromAddress}>`,
        to: message.to,
        subject: message.email.subject,
        html: message.email.html,
        text: message.email.text,
      })
      payload.logger.info({ msg: 'Email sent', type: message.type, userId: message.userId })
    } catch (error) {
      payload.logger.error({
        msg: 'Email could not be sent',
        type: message.type,
        userId: message.userId,
        reason: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  try {
    after(send)
  } catch {
    // Not inside a request (tests, the seed script): send now.
    await send()
  }
}

/** The same sending for emails that are not about signing in (project notices). */
export const sendEmail = sendSignInEmail
