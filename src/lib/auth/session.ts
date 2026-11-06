import { createLocalReq, getFieldsToSign, jwtSign, type Payload } from 'payload'
import { addSessionToUser, generatePayloadCookie } from 'payload/shared'

/**
 * Start a normal Payload session for a user who has just proved who they are (Google, and later
 * magic link). It does what Payload's own login does after the password check: record a session
 * on the user, sign a JWT that carries that session id, and build the cookie. Because it is a real
 * Payload session, the admin panel, REST, GraphQL and logout all work without a custom strategy.
 *
 * Returns the full Set-Cookie value. Never log it: it is the user's session.
 */
export async function createSessionCookie(payload: Payload, userId: number): Promise<string> {
  const collectionConfig = payload.collections.users.config
  const req = await createLocalReq({}, payload)

  // The raw database row, because the session list and hash live there.
  const user = await payload.db.findOne<Record<string, unknown> & { id: number; email: string }>({
    collection: 'users',
    where: { id: { equals: userId } },
    req,
  })
  if (!user) throw new Error('Cannot start a session for a user that does not exist')

  const { sid } = await addSessionToUser({
    collectionConfig,
    payload,
    req,
    user: user as never,
  })
  const fieldsToSign = getFieldsToSign({
    collectionConfig,
    email: user.email,
    sid,
    user: user as never,
  })
  const { token } = await jwtSign({
    fieldsToSign,
    secret: payload.secret,
    tokenExpiration: collectionConfig.auth.tokenExpiration,
  })
  return generatePayloadCookie({
    collectionAuthConfig: collectionConfig.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token,
  })
}
