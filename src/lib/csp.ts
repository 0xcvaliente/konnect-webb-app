/**
 * Content security policy for our own pages, with a fresh nonce per request. Next.js reads the
 * nonce from the request's Content-Security-Policy header and adds it to its own scripts, so the
 * pages must render per request (the locale layout calls connection()). 'strict-dynamic' lets
 * those scripts load the rest of the app. Styles stay 'unsafe-inline': Radix and Sonner set
 * inline styles for positioning. The Payload admin and /api are not matched here; they keep the
 * static headers in next.config.ts.
 */
export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}
