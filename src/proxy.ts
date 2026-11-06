import createMiddleware from 'next-intl/middleware'
import type { NextRequest } from 'next/server'

import { requestLocale } from './i18n/locale'
import { routing } from './i18n/routing'

// next-intl's own detection is off: browsers send "nb" or "nn", not "no", so we pick it below.
const intl = createMiddleware({ ...routing, localeDetection: false })

/**
 * Locale routing only: paths without /en or /no go to the user's language. This is not an access
 * check. Pages, server actions and route handlers check the user themselves.
 */
export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasLocale = routing.locales.some(
    (l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`),
  )
  if (!hasLocale) {
    const url = request.nextUrl.clone()
    url.pathname = `/${requestLocale(request)}${pathname === '/' ? '' : pathname}`
    return Response.redirect(url, 307)
  }
  return intl(request)
}

export const config = {
  // Everything except the Payload API and admin, Next internals and files with an extension.
  matcher: ['/((?!api|admin|_next|_vercel|.*\\..*).*)'],
}
