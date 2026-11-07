import en from '@/messages/en.json'
import no from '@/messages/no.json'
import type { SharedItem } from '@/lib/matching/fields'

/**
 * Emails in English and Norwegian. Every string comes from the message files
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

// ---------- Project notices: sent to the company's own address ----------

/**
 * "We received your project": the company sent a project for review. Says what happens next and
 * links to the project page. The title is the company's own text; nothing about any student.
 */
export function projectSubmittedEmail(
  locale: EmailLocale,
  title: string,
  href: string,
): RenderedEmail {
  const m = MESSAGES[locale].projectSubmitted
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body.replace('{title}', title), m.review, m.next],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: MESSAGES[locale].common.accountFooter,
  })
}

// ---------- Review decisions: sent to the company's or the student's own address ----------

/** The team's note as paragraphs (blank lines and line breaks start a new one). */
const noteParagraphs = (note: string | null | undefined): string[] =>
  (note ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

/** A price in whole kroner and the total with VAT, in the email's language. */
const formatKroner = (locale: EmailLocale, amount: number): string =>
  `${new Intl.NumberFormat(locale === 'no' ? 'nb-NO' : 'en-GB', {
    maximumFractionDigits: 2,
  }).format(amount)} kr`

export type CompanyReviewKind = 'approved' | 'rejected' | 'info_requested'

/**
 * Konnected's decision on a company: approved, rejected (with the reason, and whether the company
 * may correct its details and send them once more), or more information asked (with the note).
 */
export function companyReviewEmail(
  locale: EmailLocale,
  kind: CompanyReviewKind,
  {
    name,
    note,
    canResend,
    href,
  }: { name: string; note?: string | null; canResend?: boolean; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  if (kind === 'approved') {
    const m = all.companyApproved
    return render({
      locale,
      subject: m.subject,
      heading: m.heading,
      paragraphs: [m.body.replace('{name}', name), m.next],
      action: { label: m.button, href },
      ignore: m.ignore,
      footer: all.common.accountFooter,
    })
  }
  const m = kind === 'rejected' ? all.companyRejected : all.companyInfo
  const after =
    kind === 'rejected'
      ? canResend
        ? all.companyRejected.resend
        : all.companyRejected.final
      : all.companyInfo.resend
  return render({
    locale,
    subject: m.subject.replace('{name}', name),
    heading: m.heading,
    paragraphs: [m.body.replace('{name}', name), ...noteParagraphs(note), after],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

export type ProjectReviewKind = 'changes_requested' | 'rejected' | 'approved' | 'published'

/**
 * Konnected's decision on a project: changes asked or rejected (with the note), approved (with
 * the fixed price for a paid project), or published. The title is the company's own text.
 */
export function projectReviewEmail(
  locale: EmailLocale,
  kind: ProjectReviewKind,
  {
    title,
    note,
    price,
    href,
  }: {
    title: string
    note?: string | null
    price?: { price: number; total: number } | null
    href: string
  },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = {
    changes_requested: all.projectChanges,
    rejected: all.projectRejected,
    approved: all.projectApproved,
    published: all.projectPublished,
  }[kind]
  const paragraphs = [m.body.replace('{title}', title)]
  if (kind === 'changes_requested' || kind === 'rejected') paragraphs.push(...noteParagraphs(note))
  if (kind === 'approved' && price) {
    paragraphs.push(
      all.projectApproved.price
        .replace('{price}', formatKroner(locale, price.price))
        .replace('{total}', formatKroner(locale, price.total)),
    )
  }
  paragraphs.push(m.next)
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs,
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

export type ProfileReviewKind = 'reviewed' | 'changes_requested'

/** Konnected reviewed the student's profile, or asks for changes (with the note). */
export function profileReviewEmail(
  locale: EmailLocale,
  kind: ProfileReviewKind,
  { note, href }: { note?: string | null; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = kind === 'reviewed' ? all.profileReviewed : all.profileChanges
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.body, ...(kind === 'changes_requested' ? noteParagraphs(note) : []), m.next],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

// ---------- Applications: sent to the student's own address ----------

/** A day (`YYYY-MM-DD`) in words, in the email's language: "13 November 2026". */
const formatDay = (locale: EmailLocale, day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'no' ? 'nb-NO' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Europe/Oslo',
  }).format(new Date(Date.UTC(y!, m! - 1, d!, 12)))
}

/**
 * "We received your application": what happens next, when Konnected decides (3 working days
 * after applications close), and that withdrawing is final. The title is the company's project
 * title; the note the student wrote is not repeated.
 */
export function applicationReceivedEmail(
  locale: EmailLocale,
  {
    title,
    decideBy,
    profileWaiting,
    href,
  }: { title: string; decideBy: string | null; profileWaiting: boolean; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.applicationReceived
  const paragraphs = [
    m.body.replace('{title}', title),
    decideBy ? m.decideBy.replace('{date}', formatDay(locale, decideBy)) : m.decideNoDate,
  ]
  if (profileWaiting) paragraphs.push(m.profileWaiting)
  paragraphs.push(m.next)
  return render({
    locale,
    subject: m.subject,
    heading: m.heading,
    paragraphs,
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

// ---------- Matching: the selected student, the others, and the company ----------

/** Shared item kinds as a list in words ("name, programme and university and CV"). */
const itemList = (locale: EmailLocale, items: readonly SharedItem[]): string => {
  const words = MESSAGES[locale].matching.items
  return new Intl.ListFormat(locale === 'no' ? 'nb-NO' : 'en-GB', {
    style: 'long',
    type: 'conjunction',
  }).format(items.map((item) => words[item]))
}

/** "You are selected": to the student Konnected picked, with what the company will see. */
export function selectedEmail(
  locale: EmailLocale,
  {
    title,
    company,
    items,
    href,
  }: { title: string; company: string; items: readonly SharedItem[]; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.matching.selected
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs: [
      m.body.replace('{title}', title),
      items.length
        ? m.shares.replace('{company}', company).replace('{items}', itemList(locale, items))
        : m.sharesNothing.replace('{company}', company),
      m.next,
    ],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

/** A kind note to a student Konnected did not pick. */
export function notSelectedEmail(
  locale: EmailLocale,
  { title, href }: { title: string; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.matching.notSelected
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs: [m.body.replace('{title}', title), m.thanks],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

/**
 * "We found your student": to the company. Names only the kinds of details the student shares,
 * never the values; those wait on the project page, behind sign-in.
 */
export function studentFoundEmail(
  locale: EmailLocale,
  { title, items, href }: { title: string; items: readonly SharedItem[]; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.matching.found
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs: [
      m.body.replace('{title}', title),
      items.length ? m.shares.replace('{items}', itemList(locale, items)) : m.sharesNothing,
      m.next,
    ],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

// ---------- Deliverables: released, more asked, a fix asked, accepted ----------

/**
 * "Your deliverable is ready": to the company when Konnected releases the work. Says it can accept
 * it or ask for one round of fixes within 7 days. No student details: the work is on the project
 * page, behind sign-in.
 */
export function deliverableReleasedEmail(
  locale: EmailLocale,
  {
    title,
    fixUntil,
    paid,
    fixRound,
    href,
  }: { title: string; fixUntil: string; paid: boolean; fixRound: boolean; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.deliverables.released
  const paragraphs = [
    (fixRound ? m.bodyFixed : m.body).replace('{title}', title),
    fixRound ? m.acceptFixed : m.accept.replace('{date}', formatDay(locale, fixUntil)),
  ]
  if (paid) paragraphs.push(m.invoice)
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs,
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

/** "Konnected asked for more": to the student, before the company sees anything. */
export function deliverableReturnedEmail(
  locale: EmailLocale,
  { title, href }: { title: string; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.deliverables.returned
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs: [m.body.replace('{title}', title), m.next],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

/** "A fix is asked": to the student. The company's words wait in the app, behind sign-in. */
export function deliverableFixEmail(
  locale: EmailLocale,
  { title, company, href }: { title: string; company: string; href: string },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.deliverables.fixRequested
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading.replace('{company}', company),
    paragraphs: [m.body.replace('{title}', title).replace('{company}', company), m.next],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

/**
 * "The work is accepted": to the student and to the company. `auto` when the 7 days for fixes
 * passed without an answer.
 */
export function deliverableAcceptedEmail(
  locale: EmailLocale,
  {
    to,
    title,
    company,
    auto,
    paid,
    href,
  }: {
    to: 'student' | 'company'
    title: string
    company: string
    auto: boolean
    paid: boolean
    href: string
  },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = to === 'student' ? all.deliverables.acceptedStudent : all.deliverables.acceptedCompany
  const body = (auto ? m.bodyAuto : m.body).replace('{title}', title).replace('{company}', company)
  return render({
    locale,
    subject: m.subject.replace('{title}', title),
    heading: m.heading,
    paragraphs: [body, paid ? m.paid : m.unpaid],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}

// ---------- Problem paths: sent to the student's or the company's own address ----------

export type ProblemEmailKind =
  | 'received'
  | 'dueDateStudent'
  | 'dueDateCompany'
  | 'endedStudent'
  | 'closedStudent'
  | 'rematchCompany'
  | 'closedNoDeliveryCompany'
  | 'closedNoMatchCompany'
  | 'reopenedCompany'

/**
 * The emails of the problem paths (Kanban cards "Problem reports" and "Projects without a match").
 * The student's own note is never repeated; an email to the company names no student. `reason` is
 * the team's reason for closing, written for both parties. Days are `YYYY-MM-DD`.
 */
export function problemPathEmail(
  locale: EmailLocale,
  kind: ProblemEmailKind,
  {
    title,
    company = '',
    date,
    from,
    reason,
    href,
  }: {
    title: string
    company?: string
    date?: string | null
    from?: string | null
    reason?: string | null
    href: string
  },
): RenderedEmail {
  const all = MESSAGES[locale]
  const m = all.problems[kind]
  const fill = (text: string) =>
    text
      .replace('{title}', title)
      .replace('{company}', company)
      .replace('{date}', date ? formatDay(locale, date) : '')
      .replace('{from}', from ? formatDay(locale, from) : '')
  // A due date set for the first time in answer to the student's report has no old date.
  const body = 'bodySet' in m && !from ? m.bodySet : m.body
  return render({
    locale,
    subject: fill(m.subject),
    heading: fill(m.heading),
    paragraphs: [fill(body), ...noteParagraphs(reason), fill(m.next)],
    action: { label: m.button, href },
    ignore: m.ignore,
    footer: all.common.accountFooter,
  })
}
