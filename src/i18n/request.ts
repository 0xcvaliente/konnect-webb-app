import { hasLocale } from 'next-intl'
import { getRequestConfig } from 'next-intl/server'

import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale
  return {
    locale,
    // Dates are shown in Norway's time, on the server and in the browser alike.
    timeZone: 'Europe/Oslo',
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
