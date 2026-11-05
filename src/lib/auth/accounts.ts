import { randomBytes } from 'node:crypto'

import type { Payload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import type { User } from '@/payload-types'

import type { GoogleClaims } from './google'
import type { AuthErrorCode } from './messages'

export class AuthFlowError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(code)
  }
}

/** A password nobody knows. Google accounts have no password of their own. */
const randomPassword = () => randomBytes(48).toString('base64url')

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
  const email = claims.email.trim().toLowerCase()
  const now = new Date().toISOString()

  const find = async (where: Record<string, { equals: string }>) =>
    (
      await payload.find({
        collection: 'users',
        where,
        limit: 1,
        depth: 0,
        overrideAccess: true,
      })
    ).docs[0]

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

  const bySub = await find({ googleSub: { equals: claims.sub } })
  if (bySub) return promoteIfAdmin(bySub)

  const byEmail = await find({ email: { equals: email } })
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) {
      throw new AuthFlowError('account_conflict')
    }
    const neverProvedEmail = !byEmail.emailVerifiedAt
    const linked = (await payload.update({
      collection: 'users',
      id: byEmail.id,
      data: {
        googleSub: claims.sub,
        emailVerifiedAt: byEmail.emailVerifiedAt ?? now,
        ...(neverProvedEmail ? { password: randomPassword() } : {}),
      },
      depth: 0,
      overrideAccess: true,
    })) as User
    if (neverProvedEmail) {
      await payload.db.updateOne({
        collection: 'users',
        where: { id: { equals: byEmail.id } },
        data: { sessions: [] },
        returning: false,
      })
    }
    return promoteIfAdmin(linked)
  }

  try {
    return (await payload.create({
      collection: 'users',
      data: {
        email,
        password: randomPassword(),
        googleSub: claims.sub,
        emailVerifiedAt: now,
        role: isAdminEmail(email) ? 'admin' : 'pending',
      },
      depth: 0,
      overrideAccess: true,
    })) as User
  } catch (error) {
    // Two callbacks for the same new person at the same moment: the second hits the unique index.
    const raced = await find({ googleSub: { equals: claims.sub } })
    if (raced) return raced
    throw error
  }
}
