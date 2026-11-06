import config from '@payload-config'
import { REST_POST } from '@payloadcms/next/routes'
import { NextResponse } from 'next/server'

import { requestLocale } from '@/i18n/locale'
import { googleEnv, isSameOrigin } from '@/lib/auth/env'

/**
 * Sign out: end the Payload session and clear the cookie, then go to the entry page, which says
 * "You are signed out" (mockup "Signed out and linked").
 */
export async function POST(request: Request) {
  const { appUrl } = googleEnv()
  if (!isSameOrigin(request, appUrl)) return new Response('Forbidden', { status: 403 })

  const logout = await REST_POST(config)(
    new Request(`${appUrl}/api/users/logout`, {
      method: 'POST',
      // Same-origin was checked above, so this internal call carries our own Origin.
      headers: { cookie: request.headers.get('cookie') ?? '', origin: new URL(appUrl).origin },
    }),
    { params: Promise.resolve({ slug: ['users', 'logout'] }) },
  )

  const response = NextResponse.redirect(`${appUrl}/${requestLocale(request)}?signed_out=1`, 303)
  for (const cookie of logout.headers.getSetCookie()) response.headers.append('Set-Cookie', cookie)
  return response
}
