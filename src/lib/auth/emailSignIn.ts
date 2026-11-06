import { createHash, randomBytes } from 'node:crypto'

import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { isTeamAccount, resetLink, verifyLink } from '@/lib/email/authEmails'
import { sendSignInEmail } from '@/lib/email/send'
import {
  accountExistsEmail,
  type EmailLocale,
  magicLinkEmail,
  resetEmail,
  teamEmail,
  verifyEmail,
} from '@/lib/email/templates'
import type { User } from '@/payload-types'

import { AuthFlowError, completeEmailLinkLogin } from './accounts'
import { appUrl } from './env'
import {
  dummyPasswordHash,
  passwordLengthProblem,
  passwordProblem,
  type PasswordContext,
  type PasswordProblem,
} from './password'
import { AccountPausedError } from './paused'
import { clearRateLimit, limitReached, rateLimited } from './rateLimit'
import { createSession, type SessionCookie, sessionCookieFor } from './session'
import { withTimingFloor } from './timing'
import { confirmEmailToken } from './verification'

/**
 * Email sign-in: sign-in links, password sign-up and sign-in, password reset and email
 * confirmation. Plain functions over Payload so they can be tested without a request; the Server
 * Actions in src/app/(frontend)/[locale]/actions.ts call them.
 *
 * Rules (owner decisions, 5 Nov 2026; konnected-google-signin):
 * - Answers never show whether an account exists: the same result and, with withTimingFloor and
 *   dummy password hashes, about the same time. The real explanation goes by email to the owner
 *   of the address.
 * - Admins sign in with Google only. A request for an admin address gets the same answer and the
 *   same email flow, but the email has no link.
 * - Every request is rate limited per client address and per email address.
 * - Nothing here logs an address, token, password or cookie.
 */

const MINUTE = 60_000
export const MAGIC_LINK_TTL_MS = 15 * MINUTE

/** [limit, window] per key. */
export const LIMITS = {
  linkPerIp: [10, 15 * MINUTE],
  linkPerEmail: [3, 15 * MINUTE],
  signUpPerIp: [10, 15 * MINUTE],
  signUpPerEmail: [3, 15 * MINUTE],
  resetPerIp: [10, 15 * MINUTE],
  resetPerEmail: [3, 15 * MINUTE],
  signInPerIp: [30, 15 * MINUTE],
  /** Failed password sign-ins per address, whether or not it has an account. */
  signInFailuresPerEmail: [5, 15 * MINUTE],
  /** Using a link: sign-in link, confirmation link, reset link. */
  tokenPerIp: [20, 15 * MINUTE],
  verifyResendPerEmail: [3, 15 * MINUTE],
} as const satisfies Record<string, readonly [number, number]>

const hit = (key: string, [limit, windowMs]: readonly [number, number]) =>
  rateLimited(key, limit, windowMs)

/** Count the hit on both keys, and report whether either is over its limit. */
const hitBoth = (
  a: [string, readonly [number, number]],
  b: [string, readonly [number, number]],
) => {
  const first = hit(...a)
  const second = hit(...b)
  return first || second
}

export type AuthError =
  | 'too_many'
  | 'invalid_credentials'
  | 'locked'
  | 'unverified'
  | 'invalid_link'
  | 'paused'
  | 'generic'
export type FieldErrors = {
  email?: 'invalid'
  password?: PasswordProblem | 'required'
}
export type Failure = { ok: false; error?: AuthError; fields?: FieldErrors }
export type Done = { ok: true }
export type SignedIn = { ok: true; user: User; cookie: SessionCookie }

type Request = { locale: EmailLocale; ip: string }

export const normalizeEmail = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** A plain shape check. The real proof is the link we send. */
export const isEmailAddress = (email: string): boolean =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

const findByEmail = async (payload: Payload, email: string): Promise<User | undefined> =>
  (
    await payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

// ---------- Sign-in link ----------

/**
 * Ask for a sign-in link. Same answer and timing for every address. A new address gets a link
 * too: its account is made only when the link is used. Admin addresses get an email without one.
 */
export async function requestMagicLink(
  payload: Payload,
  { email: rawEmail, locale, ip }: Request & { email: unknown },
): Promise<Done | Failure> {
  const email = normalizeEmail(rawEmail)
  if (!isEmailAddress(email)) return { ok: false, fields: { email: 'invalid' } }
  if (hitBoth([`link-ip:${ip}`, LIMITS.linkPerIp], [`link-email:${email}`, LIMITS.linkPerEmail])) {
    return { ok: false, error: 'too_many' }
  }

  return withTimingFloor(async () => {
    const now = Date.now()
    // Keep the table small: rows a day past their expiry are of no use to anyone.
    await payload.delete({
      collection: 'magic-links',
      where: { expiresAt: { less_than: new Date(now - 24 * 60 * MINUTE).toISOString() } },
      overrideAccess: true,
    })

    const user = await findByEmail(payload, email)
    if (isAdminEmail(email) || user?.role === 'admin') {
      await sendSignInEmail(payload, {
        to: email,
        email: teamEmail(locale, 'link'),
        type: 'team_no_link',
        userId: user?.id,
      })
      return { ok: true }
    }

    // Only the newest link works (owner decision): links sent earlier for this address and not
    // used yet stop working now.
    await payload.delete({
      collection: 'magic-links',
      where: { and: [{ email: { equals: email } }, { usedAt: { exists: false } }] },
      overrideAccess: true,
    })

    // 32 random bytes. Only the SHA-256 is stored; the token itself is only in the email.
    const token = randomBytes(32).toString('base64url')
    // Bypass: links are made only by this server code; the API cannot create them.
    await payload.create({
      collection: 'magic-links',
      data: {
        tokenHash: hashToken(token),
        email,
        expiresAt: new Date(now + MAGIC_LINK_TTL_MS).toISOString(),
      },
      overrideAccess: true,
    })
    await sendSignInEmail(payload, {
      to: email,
      email: magicLinkEmail(locale, `${appUrl()}/${locale}/magic/${token}`),
      type: 'magic_link',
      userId: user?.id,
    })
    return { ok: true }
  })
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

/** Whether a sign-in link can still be used. Reads only; the page shows "expired" early. */
export async function magicLinkUsable(payload: Payload, token: string): Promise<boolean> {
  if (!TOKEN_SHAPE.test(token)) return false
  const found = await payload.find({
    collection: 'magic-links',
    where: {
      and: [
        { tokenHash: { equals: hashToken(token) } },
        { usedAt: { exists: false } },
        { expiresAt: { greater_than: new Date().toISOString() } },
      ],
    },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  return found.docs.length > 0
}

/**
 * Use a sign-in link (the page's button POSTs here; a GET never signs in, because mail scanners
 * open links). Marking it used is one atomic UPDATE that matches only an unused, unexpired link,
 * so two clicks at the same moment cannot both sign in. Then a normal Payload session.
 */
export async function consumeMagicLink(
  payload: Payload,
  { token, locale, ip }: Request & { token: string },
): Promise<SignedIn | Failure> {
  if (hit(`token-ip:${ip}`, LIMITS.tokenPerIp)) return { ok: false, error: 'too_many' }
  if (!TOKEN_SHAPE.test(token)) return { ok: false, error: 'invalid_link' }

  const now = new Date().toISOString()
  // Bypass: a direct atomic update; the token is the proof and nobody is signed in yet.
  const link = await payload.db.updateOne({
    collection: 'magic-links',
    where: {
      and: [
        { tokenHash: { equals: hashToken(token) } },
        { usedAt: { exists: false } },
        { expiresAt: { greater_than: now } },
      ],
    },
    data: { usedAt: now },
    options: { atomic: true },
    returning: true,
  })
  if (!link) return { ok: false, error: 'invalid_link' }

  try {
    const user = await completeEmailLinkLogin(payload, String(link.email), locale)
    if (!user) return { ok: false, error: 'invalid_link' }
    return { ok: true, user, cookie: await createSession(payload, user.id) }
  } catch (error) {
    // The link proved the address, so its owner may learn that the account is paused.
    if (error instanceof AccountPausedError) return { ok: false, error: 'paused' }
    if (error instanceof AuthFlowError && error.code === 'account_paused') {
      return { ok: false, error: 'paused' }
    }
    throw error
  }
}

// ---------- Password sign-up ----------

/** A fresh object every time: Payload keeps the context object by reference and hooks write to it. */
const checkedPassword = (): PasswordContext => ({ passwordChecked: true })

/**
 * Sign up with an email and a password. The password rules come first (they are about the input,
 * not the account). Then the same answer for every address: a new address gets a `pending`
 * account and a confirmation link; an address that has an account gets an email saying so and
 * nothing changes; an admin address gets an email without a link.
 */
export async function signUpWithPassword(
  payload: Payload,
  { email: rawEmail, password, locale, ip }: Request & { email: unknown; password: unknown },
): Promise<Done | Failure> {
  const email = normalizeEmail(rawEmail)
  const fields: FieldErrors = {}
  if (!isEmailAddress(email)) fields.email = 'invalid'
  if (typeof password !== 'string' || password === '') fields.password = 'required'
  else {
    const problem = passwordLengthProblem(password)
    if (problem) fields.password = problem
  }
  if (fields.email || fields.password) return { ok: false, fields }
  if (
    hitBoth(
      [`signup-ip:${ip}`, LIMITS.signUpPerIp],
      [`signup-email:${email}`, LIMITS.signUpPerEmail],
    )
  ) {
    return { ok: false, error: 'too_many' }
  }

  return withTimingFloor(async (): Promise<Done | Failure> => {
    const problem = await passwordProblem(password as string, payload.logger)
    if (problem) return { ok: false, fields: { password: problem } }

    const existing = await findByEmail(payload, email)
    if (existing || isAdminEmail(email)) {
      // No account is made, so hash anyway: a new account costs one hash.
      await dummyPasswordHash(payload)
      const team = isAdminEmail(email) || existing?.role === 'admin'
      await sendSignInEmail(payload, {
        to: email,
        email: team
          ? teamEmail(locale, 'signup')
          : accountExistsEmail(locale, `${appUrl()}/${locale}`),
        type: team ? 'team_no_link' : 'account_exists',
        userId: existing?.id,
      })
      return { ok: true }
    }

    let user: User
    try {
      // Bypass: public sign-up. `users.create` is admin-only in the API; this server code makes
      // only a `pending`, unverified account, never anything else.
      user = (await payload.create({
        collection: 'users',
        data: { email, password: password as string, role: 'pending', language: locale },
        depth: 0,
        overrideAccess: true,
        disableVerificationEmail: true,
        context: checkedPassword(),
      })) as User
    } catch (error) {
      // Two sign-ups for the same new address at the same moment: the second hits the unique
      // index. The first one's owner gets the confirmation email.
      if (await findByEmail(payload, email)) return { ok: true }
      throw error
    }
    await sendVerification(payload, user, locale)
    return { ok: true }
  })
}

/** Send a confirmation link for an unconfirmed account, with a fresh token. */
async function sendVerification(payload: Payload, user: User, locale: EmailLocale): Promise<void> {
  // Same format as Payload's own verification tokens.
  const token = randomBytes(20).toString('hex')
  const updated = await payload.db.updateOne({
    collection: 'users',
    where: { and: [{ id: { equals: user.id } }, { _verified: { not_equals: true } }] },
    data: { _verificationToken: token },
    options: { atomic: true },
    returning: true,
  })
  if (!updated) return
  await sendSignInEmail(payload, {
    to: user.email,
    email: verifyEmail(locale, verifyLink(locale, token)),
    type: 'verify',
    userId: user.id,
  })
}

// ---------- Password sign-in ----------

/**
 * Sign in with a password, through Payload's own login (lockout after 5 wrong tries for 15
 * minutes, admins refused in `beforeLogin`, unknown addresses hashed in `beforeOperation`).
 *
 * Every failure is "email or password is not right", except:
 * - `locked`: 5 failures for this address within 15 minutes, counted here for every address
 *   whether or not it has an account, so it shows nothing about the account;
 * - `unverified`: only after the right password, so only the owner sees it. A new confirmation
 *   link is sent.
 */
export async function signInWithPassword(
  payload: Payload,
  { email: rawEmail, password, locale, ip }: Request & { email: unknown; password: unknown },
): Promise<SignedIn | Failure> {
  const email = normalizeEmail(rawEmail)
  const fields: FieldErrors = {}
  if (!isEmailAddress(email)) fields.email = 'invalid'
  if (typeof password !== 'string' || password === '') fields.password = 'required'
  if (fields.email || fields.password) return { ok: false, fields }
  if (hit(`signin-ip:${ip}`, LIMITS.signInPerIp)) return { ok: false, error: 'too_many' }

  const failures = `signin-fail:${email}`
  const [maxFailures] = LIMITS.signInFailuresPerEmail
  if (limitReached(failures, maxFailures)) {
    await dummyPasswordHash(payload)
    return { ok: false, error: 'locked' }
  }

  try {
    const result = await payload.login({
      collection: 'users',
      data: { email, password: password as string },
      depth: 0,
    })
    clearRateLimit(failures)
    if (!result.token || !result.user) return { ok: false, error: 'generic' }
    return { ok: true, user: result.user as User, cookie: sessionCookieFor(payload, result.token) }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'UnverifiedEmail') {
      if (!hit(`verify-resend:${email}`, LIMITS.verifyResendPerEmail)) {
        const user = await findByEmail(payload, email)
        if (user) await sendVerification(payload, user, locale)
      }
      return { ok: false, error: 'unverified' }
    }
    // Only after the right password (Users `beforeLogin`), so only the owner learns it.
    if (name === 'AccountPaused') {
      clearRateLimit(failures)
      return { ok: false, error: 'paused' }
    }
    if (name === 'AuthenticationError' || name === 'LockedAuth') {
      // Payload's own lock is treated like a wrong password, so "locked" means only our
      // per-address count, which is the same for an address with or without an account.
      return {
        ok: false,
        error: hit(failures, LIMITS.signInFailuresPerEmail) ? 'locked' : 'invalid_credentials',
      }
    }
    payload.logger.error({ msg: 'Password sign-in failed', reason: name || 'unknown' })
    return { ok: false, error: 'generic' }
  }
}

// ---------- Password reset ----------

/**
 * Ask for a reset link. Same answer and timing for every address. Unknown addresses get nothing;
 * admins get an email without a link; everyone else gets a single-use link valid for an hour.
 */
export async function requestPasswordReset(
  payload: Payload,
  { email: rawEmail, locale, ip }: Request & { email: unknown },
): Promise<Done | Failure> {
  const email = normalizeEmail(rawEmail)
  if (!isEmailAddress(email)) return { ok: false, fields: { email: 'invalid' } }
  if (
    hitBoth([`reset-ip:${ip}`, LIMITS.resetPerIp], [`reset-email:${email}`, LIMITS.resetPerEmail])
  ) {
    return { ok: false, error: 'too_many' }
  }

  return withTimingFloor(async (): Promise<Done> => {
    const user = await findByEmail(payload, email)
    if (!user) return { ok: true }
    if (isTeamAccount(user)) {
      await sendSignInEmail(payload, {
        to: email,
        email: teamEmail(locale, 'reset'),
        type: 'team_no_link',
        userId: user.id,
      })
      return { ok: true }
    }
    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email },
      disableEmail: true,
    })
    if (token) {
      await sendSignInEmail(payload, {
        to: email,
        email: resetEmail(locale, resetLink(locale, token)),
        type: 'password_reset',
        userId: user.id,
      })
    }
    return { ok: true }
  })
}

const RESET_TOKEN_SHAPE = /^[0-9a-f]{40}$/

/**
 * The address a reset link belongs to, or null when the link cannot be used. Reads only. The page
 * puts the address in a hidden username field so password managers save the new password for
 * the right account; whoever holds the link already has that address.
 */
export async function resetTokenEmail(payload: Payload, token: string): Promise<string | null> {
  if (!RESET_TOKEN_SHAPE.test(token)) return null
  const user = await payload.db.findOne<{ id: number; email: string }>({
    collection: 'users',
    where: {
      and: [
        { resetPasswordToken: { equals: token } },
        { resetPasswordExpiration: { greater_than: new Date().toISOString() } },
      ],
    },
  })
  return user?.email ?? null
}

/** Whether a reset link can still be used. Reads only. */
export async function resetTokenUsable(payload: Payload, token: string): Promise<boolean> {
  return (await resetTokenEmail(payload, token)) !== null
}

/**
 * Set a new password with a reset link. Payload checks the token and its expiry, applies the
 * password rules again, ends every session of the user and marks the email confirmed (see the
 * `beforeOperation` and `beforeValidate` hooks on `users`). Admins are refused in `beforeLogin`
 * and the whole change is rolled back. The user then signs in with the new password.
 */
export async function resetPasswordWithToken(
  payload: Payload,
  { token, password, ip }: { token: string; password: unknown; ip: string },
): Promise<Done | Failure> {
  if (hit(`token-ip:${ip}`, LIMITS.tokenPerIp)) return { ok: false, error: 'too_many' }
  if (!(await resetTokenUsable(payload, token))) return { ok: false, error: 'invalid_link' }
  if (typeof password !== 'string' || password === '') {
    return { ok: false, fields: { password: 'required' } }
  }
  const problem = await passwordProblem(password, payload.logger)
  if (problem) return { ok: false, fields: { password: problem } }

  try {
    await payload.resetPassword({
      collection: 'users',
      data: { token, password },
      overrideAccess: true,
      context: checkedPassword(),
    })
    return { ok: true }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'APIError' || name === 'AuthenticationError' || name === 'Forbidden') {
      return { ok: false, error: 'invalid_link' }
    }
    payload.logger.error({ msg: 'Password reset failed', reason: name || 'unknown' })
    return { ok: false, error: 'generic' }
  }
}

// ---------- Email confirmation ----------

/** Confirm an address with the link from the sign-up email (the page's button POSTs here). */
export async function confirmEmail(
  payload: Payload,
  { token, ip }: { token: string; ip: string },
): Promise<Done | Failure> {
  if (hit(`token-ip:${ip}`, LIMITS.tokenPerIp)) return { ok: false, error: 'too_many' }
  return (await confirmEmailToken(payload, token))
    ? { ok: true }
    : { ok: false, error: 'invalid_link' }
}
