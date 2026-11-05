import { NextResponse } from 'next/server'

import { googleEnv, signingSecret } from '@/lib/auth/env'
import { startGoogleSignIn } from '@/lib/auth/google'
import { cookieHeader, OIDC_COOKIE, OIDC_COOKIE_MAX_AGE, sealChecks } from '@/lib/auth/oidcCookie'
import { clientKey, rateLimited } from '@/lib/auth/rateLimit'

/** Step 1: send the browser to Google. The checks travel in a signed, short-lived cookie. */
export async function GET(request: Request) {
  const { appUrl } = googleEnv()
  if (rateLimited(clientKey(request, 'google-start'), 20, 60_000)) {
    return NextResponse.redirect(`${appUrl}/?auth_error=too_many_requests`)
  }

  const { url, checks } = await startGoogleSignIn()
  const response = NextResponse.redirect(url)
  response.headers.append(
    'Set-Cookie',
    cookieHeader(OIDC_COOKIE, sealChecks(checks, signingSecret()), {
      maxAge: OIDC_COOKIE_MAX_AGE,
      path: '/api/auth/google',
      secure: appUrl.startsWith('https://'),
    }),
  )
  return response
}
