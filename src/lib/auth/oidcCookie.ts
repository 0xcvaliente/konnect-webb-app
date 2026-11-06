import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The short-lived cookie that carries the sign-in checks between "start" and "callback":
 * `state`, `nonce` and the PKCE verifier. It is signed with the Payload secret, HttpOnly,
 * SameSite=Lax (Google's redirect is a top-level GET, so Lax still sends it) and expires in
 * 10 minutes. It never holds a token.
 */
export const OIDC_COOKIE = 'konnected_oidc'
export const OIDC_COOKIE_MAX_AGE = 10 * 60

export type OidcChecks = { state: string; nonce: string; verifier: string }

const sign = (value: string, secret: string) =>
  createHmac('sha256', secret).update(value).digest('base64url')

export function sealChecks(checks: OidcChecks, secret: string): string {
  const body = Buffer.from(JSON.stringify(checks)).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/** Returns the checks, or null when the cookie is missing, altered or malformed. */
export function openChecks(cookie: string | undefined, secret: string): OidcChecks | null {
  if (!cookie) return null
  const [body, signature] = cookie.split('.')
  if (!body || !signature) return null
  const expected = sign(body, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<OidcChecks>
    if (!parsed.state || !parsed.nonce || !parsed.verifier) return null
    return { state: parsed.state, nonce: parsed.nonce, verifier: parsed.verifier }
  } catch {
    return null
  }
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAge: number; path: string; secure: boolean },
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}
