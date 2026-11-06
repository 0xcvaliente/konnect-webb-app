import type { Payload } from 'payload'

/**
 * Confirm an email address with the token from a verification email. One atomic UPDATE that
 * matches only the row still holding this token, so a token works once. It sets Payload's
 * `_verified` (which password sign-in checks) and our `emailVerifiedAt` together, and clears the
 * token. Confirming does not sign anyone in: the user signs in with their password afterwards.
 *
 * Bypass: a direct database update, because nobody is signed in and both fields are admin-only
 * in the API. The token is the proof.
 */
export async function confirmEmailToken(payload: Payload, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{20,128}$/i.test(token)) return false
  const updated = await payload.db.updateOne({
    collection: 'users',
    where: { _verificationToken: { equals: token } },
    data: { _verified: true, _verificationToken: null, emailVerifiedAt: new Date().toISOString() },
    options: { atomic: true },
    returning: true,
  })
  return Boolean(updated)
}

/** Whether a confirmation link can still be used. Reads only; the page shows "used" early. */
export async function verificationTokenUsable(payload: Payload, token: string): Promise<boolean> {
  if (!/^[0-9a-f]{20,128}$/i.test(token)) return false
  const user = await payload.db.findOne({
    collection: 'users',
    where: { _verificationToken: { equals: token } },
  })
  return Boolean(user)
}
