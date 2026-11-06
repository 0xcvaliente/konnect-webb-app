import { randomBytes } from 'node:crypto'

import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import type { User } from '@/payload-types'

import type { GoogleClaims } from './google'
import type { AuthErrorCode } from './messages'
import type { PasswordContext } from './password'

export class AuthFlowError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(code)
  }
}

/** A password nobody knows. Google and email-link accounts have no password of their own. */
const randomPassword = () => randomBytes(48).toString('base64url')

/**
 * Server-made random passwords skip the breach check (see validatePassword). A fresh object each
 * time: Payload keeps the context object by reference and hooks write to it.
 */
const generated = (): PasswordContext => ({ generatedPassword: true })

const normalizeEmail = (email: string) => email.trim().toLowerCase()

const findUser = async (payload: Payload, where: Record<string, { equals: string }>) =>
  (
    await payload.find({
      collection: 'users',
      where,
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0]

/**
 * Record that the person controls this account's email address, and link `extra` (the Google id).
 * If the account never proved its email (someone may have registered the address with a password
 * they chose), its password is replaced and all its sessions are ended. Otherwise they could sign
 * in to the real owner's account later.
 */
async function proveEmail(payload: Payload, user: User, extra: Partial<User> = {}): Promise<User> {
  const neverProvedEmail = !user.emailVerifiedAt
  const updated = (await payload.update({
    collection: 'users',
    id: user.id,
    data: {
      emailVerifiedAt: user.emailVerifiedAt ?? new Date().toISOString(),
      _verified: true,
      ...(neverProvedEmail ? { password: randomPassword() } : {}),
      ...extra,
    },
    depth: 0,
    overrideAccess: true,
    context: generated(),
  })) as User
  if (neverProvedEmail) {
    await payload.db.updateOne({
      collection: 'users',
      where: { id: { equals: user.id } },
      data: { sessions: [] },
      returning: false,
    })
  }
  return updated
}

/** A new account with a proved email and no role yet. Payload sends no verification email. */
const createProvedAccount = async (
  payload: Payload,
  data: { email: string; role: User['role']; googleSub?: string; language?: User['language'] },
): Promise<User> =>
  (await payload.create({
    collection: 'users',
    data: {
      ...data,
      password: randomPassword(),
      emailVerifiedAt: new Date().toISOString(),
      _verified: true,
    },
    depth: 0,
    overrideAccess: true,
    disableVerificationEmail: true,
    context: generated(),
  })) as User

/**
 * Find or create the account for a verified Google identity. Rules:
 * - A returning Google user is matched by the Google account id (`sub`), never by email.
 * - An existing account is linked by email only when Google says the email is verified.
 * - If that existing account never proved its email (someone may have registered the address with
 *   a password they chose), the password is replaced and all its sessions are ended. Otherwise
 *   they could sign in to the real owner's account later.
 * - A new account has role `pending` until the user picks student or company. `admin` is granted
 *   only to a verified email on the ADMIN_EMAILS list, never from anything the user sends.
 *
 * Bypass: every read and write here uses `overrideAccess: true`. Nobody is signed in yet, and the
 * `role`, `googleSub` and `emailVerifiedAt` fields are admin-only in the API on purpose, so this
 * server code is the only place that sets them.
 */
export async function completeGoogleLogin(payload: Payload, claims: GoogleClaims): Promise<User> {
  if (!claims.emailVerified || !claims.email) throw new AuthFlowError('unverified_email')
  const email = normalizeEmail(claims.email)
  const now = new Date().toISOString()

  const promoteIfAdmin = async (user: User): Promise<User> => {
    if (user.role === 'admin' || !isAdminEmail(user.email)) return user
    return (await payload.update({
      collection: 'users',
      id: user.id,
      data: { role: 'admin', emailVerifiedAt: user.emailVerifiedAt ?? now },
      depth: 0,
      overrideAccess: true,
    })) as User
  }

  const bySub = await findUser(payload, { googleSub: { equals: claims.sub } })
  if (bySub) return promoteIfAdmin(bySub)

  const byEmail = await findUser(payload, { email: { equals: email } })
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) {
      throw new AuthFlowError('account_conflict')
    }
    return promoteIfAdmin(await proveEmail(payload, byEmail, { googleSub: claims.sub }))
  }

  try {
    return await createProvedAccount(payload, {
      email,
      googleSub: claims.sub,
      role: isAdminEmail(email) ? 'admin' : 'pending',
    })
  } catch (error) {
    // Two callbacks for the same new person at the same moment: the second hits the unique index.
    const raced = await findUser(payload, { googleSub: { equals: claims.sub } })
    if (raced) return raced
    throw error
  }
}

/**
 * Find or create the account for someone who just used an email sign-in link, which proves they
 * control the address. Same linking rules as Google: an existing account is linked by this
 * verified email, an account that never proved its email loses its password and sessions, and a
 * new address gets a `pending` account. Never for admins (Google only): returns null.
 *
 * Bypass: `overrideAccess: true`, for the same reason as completeGoogleLogin.
 */
export async function completeEmailLinkLogin(
  payload: Payload,
  rawEmail: string,
  language: User['language'],
): Promise<User | null> {
  const email = normalizeEmail(rawEmail)
  if (isAdminEmail(email)) return null
  const existing = await findUser(payload, { email: { equals: email } })
  if (existing) return existing.role === 'admin' ? null : proveEmail(payload, existing)
  try {
    return await createProvedAccount(payload, { email, role: 'pending', language })
  } catch (error) {
    // The same new address used twice at the same moment.
    const raced = await findUser(payload, { email: { equals: email } })
    if (raced) return raced.role === 'admin' ? null : raced
    throw error
  }
}
