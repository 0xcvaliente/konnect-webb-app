import {
  createLocalReq,
  getFieldsToSign,
  jwtSign,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { addSessionToUser, generatePayloadCookie } from 'payload/shared'

import { AccountPausedError, isPaused } from './paused'

/** How a session made here started: Google, or an email link (magic link). */
export type SessionMethod = 'google' | 'email_link'

/** The token claim that carries the SessionMethod. */
export const SIGN_IN_METHOD_CLAIM = 'signInMethod'

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

/**
 * End every session of a user: every session started before now is void, and the session rows are
 * removed. The time matters because Payload writes the whole user row, sessions included, from
 * the copy it read when an operation began: a sign-in, a sign-out or a profile save that started
 * before this would otherwise put the old sessions back. The database refuses session rows older
 * than `sessionsValidAfter` (migration 20261106_210116_accounts_hold_against_stale_writes).
 *
 * Two writes on purpose: Payload turns a write of a column plus the session list into an
 * INSERT ... ON CONFLICT of a partial row, which Postgres refuses (no email). The time goes first,
 * so from then on no old session can be stored again. Pass `req` to stay in its transaction.
 *
 * Bypass: direct database writes of server-only fields. Callers check who may do this.
 */
export async function revokeAllSessions(
  payload: Payload,
  userId: number,
  req?: PayloadRequest,
): Promise<void> {
  const where = { id: { equals: userId } }
  await payload.db.updateOne({
    collection: 'users',
    where,
    data: { sessionsValidAfter: new Date().toISOString() },
    returning: false,
    req,
  })
  await payload.db.updateOne({
    collection: 'users',
    where,
    data: { sessions: [] },
    returning: false,
    req,
  })
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
 * A paused account is refused (AccountPausedError). Returns the signed token. Never log it: it is
 * the user's session.
 */
export async function createSessionToken(
  payload: Payload,
  userId: number,
  method?: SessionMethod,
): Promise<string> {
  const collectionConfig = payload.collections.users.config
  const req = await createLocalReq({}, payload)

  // The raw database row, because the session list and hash live there.
  const user = await payload.db.findOne<Record<string, unknown> & { id: number; email: string }>({
    collection: 'users',
    where: { id: { equals: userId } },
    req,
  })
  if (!user) throw new Error('Cannot start a session for a user that does not exist')
  // A paused account gets no session, whichever way it proved who it is.
  if (isPaused(user as { accountStatus?: string })) throw new AccountPausedError()

  const { sid } = await addSessionToUser({
    collectionConfig,
    payload,
    req,
    user: user as never,
  })
  // The pause may have landed between the read above and the session write. The database
  // refuses session rows for a paused account; read the status again so the person gets the
  // paused answer instead of a cookie that does not work.
  const fresh = await payload.db.findOne<{ id: number; accountStatus?: string | null }>({
    collection: 'users',
    where: { id: { equals: userId } },
    select: { accountStatus: true },
    req,
  })
  if (!fresh || isPaused(fresh)) throw new AccountPausedError()

  const fieldsToSign = getFieldsToSign({
    collectionConfig,
    email: user.email,
    sid,
    user: user as never,
  })
  const { token } = await jwtSign({
    // `signInMethod` says how this session started, for the agreement signing record. Payload
    // ignores claims it does not know. Payload's own password login leaves it out.
    fieldsToSign: method ? { ...fieldsToSign, [SIGN_IN_METHOD_CLAIM]: method } : fieldsToSign,
    secret: payload.secret,
    tokenExpiration: collectionConfig.auth.tokenExpiration,
  })
  // Bypass: a direct write of the server-kept sign-in time (admin-only field in the API).
  await payload.db.updateOne({
    collection: 'users',
    where: { id: { equals: userId } },
    data: { lastSignInAt: new Date().toISOString() },
    returning: false,
    req,
  })
  return token
}

/** The same session as a full Set-Cookie value, for route handlers. Never log it. */
export async function createSessionCookie(
  payload: Payload,
  userId: number,
  method?: SessionMethod,
): Promise<string> {
  return generatePayloadCookie({
    collectionAuthConfig: payload.collections.users.config.auth,
    cookiePrefix: payload.config.cookiePrefix,
    token: await createSessionToken(payload, userId, method),
  })
}

/** The same session as cookie parts, for Server Actions. Never log it. */
export async function createSession(
  payload: Payload,
  userId: number,
  method?: SessionMethod,
): Promise<SessionCookie> {
  return sessionCookieFor(payload, await createSessionToken(payload, userId, method))
}
