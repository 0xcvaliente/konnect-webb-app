import { type AccessUser, isAdmin } from '@/access/roles'
import { SIGN_IN_METHOD_CLAIM } from '@/lib/auth/session'

import type { SignInMethodUsed } from './fields'

/**
 * How the signer had signed in to the session they sign with, for the signing record.
 *
 * - Admins sign in with Google only (the password login and email links are blocked for them).
 * - Sessions made by our Google and email-link sign-in carry a `signInMethod` claim in the token
 *   (lib/auth/session.ts). The token was already verified by `payload.auth` for this request; this
 *   only reads the claim, and only when the token belongs to the same user.
 * - Payload's own password login sets no claim: a token without one, for an account that has a
 *   password, is a password sign-in. Anything else is `unknown`.
 *
 * Never logs the cookie or the token.
 */
export function signInMethodOf(
  cookieHeader: string | null,
  cookiePrefix: string,
  user: AccessUser & { passwordSetAt?: string | null },
): SignInMethodUsed {
  if (isAdmin(user)) return 'google'
  const name = `${cookiePrefix}-token=`
  const raw = (cookieHeader ?? '')
    .split(/;\s*/)
    .find((part) => part.startsWith(name))
    ?.slice(name.length)
  if (raw) {
    try {
      const body = JSON.parse(Buffer.from(raw.split('.')[1] ?? '', 'base64url').toString('utf8'))
      if (body?.id === user.id) {
        const claim = body[SIGN_IN_METHOD_CLAIM]
        if (claim === 'google' || claim === 'email_link') return claim
        if (user.passwordSetAt) return 'password'
      }
    } catch {
      // Not a token we can read: fall through.
    }
  }
  return 'unknown'
}
