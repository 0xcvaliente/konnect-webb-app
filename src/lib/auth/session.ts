import { createLocalReq, getFieldsToSign, jwtSign, type Payload } from 'payload'
import { addSessionToUser, generatePayloadCookie } from 'payload/shared'

/** The Payload session cookie as separate parts, for `cookies().set()` in a Server Action. */
export type SessionCookie = {
  name: string
  value: string
  expires?: Date
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict' | 'none'
  path: string
  domain?: string
}

/** Build Payload's session cookie for a signed token, as parts. Never log it. */
export function sessionCookieFor(payload: Payload, token: string): SessionCookie {
  const cookie = generatePayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    returnCookieAsObject: true,
    token,
  })
  return {
    name: cookie.name,
    value: cookie.value ?? '',
    expires: cookie.expires ? new Date(cookie.expires) : undefined,
    httpOnly: cookie.httpOnly ?? true,
    secure: Boolean(cookie.secure),
    sameSite: (cookie.sameSite ?? 'Lax').toLowerCase() as SessionCookie['sameSite'],
    path: cookie.path ?? '/',
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  }
}

/**
 * Start a normal Payload session for a user who has just proved who they are (Google or an email
 * link). It does what Payload's own login does after the password check: record a session on the
 * user, sign a JWT that carries that session id, and build the cookie. Because it is a real
 * Payload session, the admin panel, REST, GraphQL and logout all work without a custom strategy.
 *
 * Returns the signed token. Never log it: it is the user's session.
 */
export async function createSessionToken(payload: Payload, userId: number): Promise<string> {
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
  return token
}

/** The same session as a full Set-Cookie value, for route handlers. Never log it. */
export async function createSessionCookie(payload: Payload, userId: number): Promise<string> {
  return generatePayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token: await createSessionToken(payload, userId),
  })
}

/** The same session as cookie parts, for Server Actions. Never log it. */
export async function createSession(payload: Payload, userId: number): Promise<SessionCookie> {
  return sessionCookieFor(payload, await createSessionToken(payload, userId))
}
