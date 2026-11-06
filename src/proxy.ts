import createMiddleware from 'next-intl/middleware'
import { NextRequest } from 'next/server'

import { requestLocale } from './i18n/locale'
import { routing } from './i18n/routing'
import { contentSecurityPolicy } from './lib/csp'

// next-intl's own detection is off: browsers send "nb" or "nn", not "no", so we pick it below.
const intl = createMiddleware({ ...routing, localeDetection: false })

/**
 * Locale routing and the CSP header. This is not an access check: pages, server actions and route
 * handlers check the user themselves.
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

  const nonce = btoa(crypto.randomUUID())
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development')
  // next-intl copies these request headers into the request the page renders with.
  const headers = new Headers(request.headers)
  headers.set('Content-Security-Policy', csp)
  const response = intl(new NextRequest(request, { headers }))
  response.headers.set('Content-Security-Policy', csp)

  // Remember the language of the page the user is on, so redirects from the sign-in routes
  // (which have no /en or /no in their path) send them back in the same language.
  const locale = pathname.split('/')[1]!
  if (request.cookies.get('NEXT_LOCALE')?.value !== locale) {
    response.cookies.set('NEXT_LOCALE', locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    })
  }
  return response
}

export const config = {
  // Everything except the Payload API and admin, Next internals and files with an extension.
  matcher: ['/((?!api(?:/|$)|admin(?:/|$)|_next|_vercel|.*\\..*).*)'],
}
