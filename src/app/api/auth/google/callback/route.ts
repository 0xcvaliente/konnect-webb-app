import config from '@payload-config'
import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import { parseCookies } from 'payload/shared'

import { requestLocale } from '@/i18n/locale'
import { AuthFlowError, completeGoogleLogin } from '@/lib/auth/accounts'
import { googleEnv, signingSecret } from '@/lib/auth/env'
import { exchangeGoogleCode } from '@/lib/auth/google'
import type { AuthErrorCode } from '@/lib/auth/messages'
import { cookieHeader, OIDC_COOKIE, openChecks } from '@/lib/auth/oidcCookie'
import { clientKey, rateLimited } from '@/lib/auth/rateLimit'
import { createSessionCookie } from '@/lib/auth/session'

/**
 * Step 2: Google sends the user back here with a code. Check everything, find or create the
 * account, start a session. Every failure ends on the home page with a message code, never a 500.
 * Nothing sensitive is logged: not the code, state, tokens, cookies or the address.
 */
export async function GET(request: Request) {
  const { appUrl } = googleEnv()
  const secure = appUrl.startsWith('https://')
  const clearChecks = cookieHeader(OIDC_COOKIE, '', { maxAge: 0, path: '/api/auth/google', secure })

  const finish = (path: string, sessionCookie?: string) => {
    const response = NextResponse.redirect(`${appUrl}${path}`)
    response.headers.append('Set-Cookie', clearChecks)
    if (sessionCookie) response.headers.append('Set-Cookie', sessionCookie)
    return response
  }
  const locale = requestLocale(request)
  const fail = (code: AuthErrorCode) => finish(`/${locale}?auth_error=${code}`)

  if (rateLimited(clientKey(request, 'google-callback'), 20, 60_000)) {
    return fail('too_many_requests')
  }

  const incoming = new URL(request.url)
  const googleError = incoming.searchParams.get('error')
  if (googleError) return fail(googleError === 'access_denied' ? 'cancelled' : 'google_error')

  const checks = openChecks(parseCookies(request.headers).get(OIDC_COOKIE), signingSecret())
  if (!checks) return fail('session_expired')

  const payload = await getPayload({ config })

  let claims
  try {
    // The redirect address comes from APP_URL, not from the Host header.
    claims = await exchangeGoogleCode(
      new URL(`${appUrl}${incoming.pathname}${incoming.search}`),
      checks,
    )
  } catch (error) {
    payload.logger.warn({ msg: 'Google sign-in failed', reason: (error as Error).name })
    return fail('google_error')
  }

  try {
    const user = await completeGoogleLogin(payload, claims)
    const sessionCookie = await createSessionCookie(payload, user.id, 'google')
    return finish(user.role === 'pending' ? `/${locale}/choose-role` : `/${locale}`, sessionCookie)
  } catch (error) {
    if (error instanceof AuthFlowError) return fail(error.code)
    payload.logger.error({ msg: 'Sign-in could not be completed', reason: (error as Error).name })
    return fail('google_error')
  }
}
