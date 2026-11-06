import { pickLanguage } from '@/lib/auth/messages'

import { type Locale, routing } from './routing'

const isLocale = (value: string | undefined): value is Locale =>
  (routing.locales as readonly string[]).includes(value ?? '')

/**
 * The locale for a request whose path has no /en or /no: "/" in the proxy, and redirects from the
 * sign-in, sign-out and role routes. The language the user last chose wins (next-intl's
 * NEXT_LOCALE cookie), then the browser's language ("nb" and "nn" mean Norwegian).
 */
export function requestLocale(request: Request): Locale {
  const chosen = /(?:^|;\s*)NEXT_LOCALE=([^;]*)/.exec(request.headers.get('cookie') ?? '')?.[1]
  if (isLocale(chosen)) return chosen
  return pickLanguage(request.headers.get('accept-language'))
}
