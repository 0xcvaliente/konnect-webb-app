import en from '@/messages/en.json'
import no from '@/messages/no.json'

/**
 * Sign-in emails in English and Norwegian. Every string comes from the message files
 * (`Email.*`), so both languages stay complete (a test checks that the two files have the same
 * keys). Each email has a subject, an HTML body and a plain-text body. No tracking pixels, no
 * images, no link rewriting. Links are built from APP_URL by the caller.
 */
export type EmailLocale = 'en' | 'no'
export type RenderedEmail = { subject: string; html: string; text: string }

type EmailMessages = (typeof en)['Email']
const MESSAGES: Record<EmailLocale, EmailMessages> = { en: en.Email, no: no.Email }

export const emailLocale = (value: unknown): EmailLocale => (value === 'no' ? 'no' : 'en')

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

export type Parts = {
  locale: EmailLocale
  subject: string
  heading: string
  paragraphs: string[]
  action?: { label: string; href: string }
  ignore: string
  /** The last line. Sign-in emails say the address was used on the sign-in page. */
  footer?: string
}

/** One plain layout for every email: word mark, heading, text, one button, the small print. */
export function render({
  locale,
  subject,
  heading,
  paragraphs,
  action,
  ignore,
  footer: footerText,
}: Parts): RenderedEmail {
  const common = MESSAGES[locale].common
  const footer = footerText ?? common.footer
  const small = 'margin:0 0 12px;font-size:13px;line-height:1.5;color:#4B676D'
  const html = [
    '<!doctype html>',
    `<html lang="${locale === 'no' ? 'nb' : 'en'}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#FFFFFF;color:#0B2A31;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;padding:28px 20px">',
    '<p style="margin:0 0 24px;font-size:18px;font-weight:600;letter-spacing:-0.015em;color:#005F73">Konnected</p>',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600">${escapeHtml(heading)}</h1>`,
    ...paragraphs.map(
      (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.5">${escapeHtml(p)}</p>`,
    ),
    ...(action
      ? [
          `<p style="margin:24px 0"><a href="${escapeHtml(action.href)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#005F73;color:#FFFFFF;font-weight:600;font-size:15px;text-decoration:none">${escapeHtml(action.label)}</a></p>`,
          `<p style="${small}">${escapeHtml(common.linkFallback)}<br><a href="${escapeHtml(action.href)}" style="color:#005F73;word-break:break-all">${escapeHtml(action.href)}</a></p>`,
        ]
      : []),
    `<p style="${small}">${escapeHtml(ignore)}</p>`,
    `<p style="${small}">${escapeHtml(footer)}</p>`,
    '</div></body></html>',
  ].join('')

  const text = [
    heading,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(action ? [`${action.label}: ${action.href}`, ''] : []),
    ignore,
    '',
    footer,
  ].join('\n')

  return { subject, html, text }
}

/** "Confirm your email": sent at sign-up with a password. */
export function verifyEmail(locale: EmailLocale, href: string): RenderedEmail {
  const m = MESSAGES[locale].verify
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body],
    action: { label: m.button, href },
    ignore: m.ignore,
  })
}

/** The sign-in link. It works once and for 15 minutes. */
export function magicLinkEmail(locale: EmailLocale, href: string): RenderedEmail {
  const m = MESSAGES[locale].magicLink
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body],
    action: { label: m.button, href },
    ignore: m.ignore,
  })
}

/** Sign-up with an address that already has an account. Nothing about the account changes. */
export function accountExistsEmail(locale: EmailLocale, href: string): RenderedEmail {
  const m = MESSAGES[locale].accountExists
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body, m.howTo],
    action: { label: m.button, href },
    ignore: m.ignore,
  })
}

export type TeamRequest = 'link' | 'signup' | 'reset'

/**
 * For a Konnected team address (admins sign in with Google only): the same email flow and subject
 * as anyone else, but no link, so a request for an admin address looks like any other.
 */
export function teamEmail(locale: EmailLocale, request: TeamRequest): RenderedEmail {
  const m = MESSAGES[locale]
  const subject = {
    link: m.magicLink.subject,
    signup: m.verify.subject,
    reset: m.reset.subject,
  }[request]
  return render({
    locale,
    subject,
    heading: m.team.heading,
    paragraphs: [m.team[request], m.team.google],
    ignore: m.team.ignore,
  })
}

/** Reset link. Single use, about one hour. */
export function resetEmail(locale: EmailLocale, href: string): RenderedEmail {
  const m = MESSAGES[locale].reset
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body],
    action: { label: m.button, href },
    ignore: m.ignore,
  })
}

// ---------- Account notices: sent to the account's own address, never to anyone else ----------

export type SignInMethod = 'google' | 'password'

/** "A new way to sign in was added": Google linked to the account, or a password set. */
export function methodAddedEmail(
  locale: EmailLocale,
  method: SignInMethod,
  href: string,
): RenderedEmail {
  const m = MESSAGES[locale].methodAdded
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m[method], m.body],
    action: { label: m.button, href },
    ignore: m.notYou,
    footer: MESSAGES[locale].common.accountFooter,
  })
}

/** The team paused the account. The reason stays with the team; the email says what it means. */
export function accountPausedEmail(locale: EmailLocale): RenderedEmail {
  const m = MESSAGES[locale].accountPaused
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body, m.contact],
    ignore: m.ignore,
    footer: MESSAGES[locale].common.accountFooter,
  })
}

/** The team made a paused account active again. */
export function accountReactivatedEmail(locale: EmailLocale, href: string): RenderedEmail {
  const m = MESSAGES[locale].accountReactivated
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: MESSAGES[locale].common.accountFooter,
  })
}

/** The team fixed a wrong role pick. The person answers the new role's questions next time. */
export function roleChangedEmail(
  locale: EmailLocale,
  role: 'student' | 'company',
  href: string,
): RenderedEmail {
  const m = MESSAGES[locale].roleChanged
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m[role], m.body],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: MESSAGES[locale].common.accountFooter,
  })
}
