import type { PayloadRequest } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { appUrl } from '@/lib/auth/env'

import { emailLocale, type EmailLocale, resetEmail, teamEmail, verifyEmail } from './templates'

/**
 * The verification and reset emails Payload sends itself (`auth.verify` and
 * `auth.forgotPassword` on `users`): through its REST endpoints, or when an admin creates a user
 * in the admin panel. The app's own pages send the same templates through `sendSignInEmail`.
 */
type AuthEmailUser = { email?: string | null; role?: string | null; language?: string | null }
type Args = { req?: PayloadRequest; token?: string; user?: AuthEmailUser }

/** Admins sign in with Google only: they never get a reset or verification link. */
export const isTeamAccount = (user?: AuthEmailUser): boolean =>
  user?.role === 'admin' || isAdminEmail(user?.email ?? undefined)

/** The language of the page the request came from, else the language saved on the account. */
const localeOf = ({ req, user }: Args): EmailLocale =>
  emailLocale((req?.context as { emailLocale?: string } | undefined)?.emailLocale ?? user?.language)

export const resetLink = (locale: EmailLocale, token: string): string =>
  `${appUrl()}/${locale}/reset-password/${encodeURIComponent(token)}`

export const verifyLink = (locale: EmailLocale, token: string): string =>
  `${appUrl()}/${locale}/verify/${encodeURIComponent(token)}`

/**
 * Admins get an email without a link, built and sent exactly like everyone else's, so the answer
 * and its timing do not reveal which addresses are admins. The stored token is never shown.
 */
const resetFor = (args: Args = {}) =>
  isTeamAccount(args.user) || !args.token
    ? teamEmail(localeOf(args), 'reset')
    : resetEmail(localeOf(args), resetLink(localeOf(args), args.token))

export const resetEmailSubject = (args: Args = {}): string => resetFor(args).subject
export const resetEmailHTML = (args: Args = {}): string => resetFor(args).html

const verifyFor = (args: Args = {}) =>
  isTeamAccount(args.user) || !args.token
    ? teamEmail(localeOf(args), 'signup')
    : verifyEmail(localeOf(args), verifyLink(localeOf(args), args.token))

export const verifyEmailSubject = (args: Args = {}): string => verifyFor(args).subject
export const verifyEmailHTML = (args: Args = {}): string => verifyFor(args).html
