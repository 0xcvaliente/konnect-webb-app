/**
 * Settings for the sign-in flows. `APP_URL` is fixed in the environment. The redirect address is
 * never built from request headers, so a forged Host header cannot redirect a sign-in elsewhere.
 */
export type GoogleEnv = { clientId: string; clientSecret: string; appUrl: string }

export function googleEnv(): GoogleEnv {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const appUrl = process.env.APP_URL?.replace(/\/+$/, '')
  if (!clientId || !clientSecret || !appUrl) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_URL must be set')
  }
  return { clientId, clientSecret, appUrl }
}

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback'

/** The key that signs the short-lived sign-in cookie. Same secret as Payload. */
export function signingSecret(): string {
  const secret = process.env.PAYLOAD_SECRET
  if (!secret) throw new Error('PAYLOAD_SECRET must be set')
  return secret
}

/** True when the request came from our own site (or sent no Origin, like a plain navigation). */
export function isSameOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(appUrl).origin
}

/** The app's public address from APP_URL, without a trailing slash. Links in emails start here. */
export function appUrl(): string {
  const url = process.env.APP_URL?.replace(/\/+$/, '')
  if (!url) throw new Error('APP_URL must be set')
  return url
}
