import { defineRouting } from 'next-intl/routing'

/** Every page lives under /en or /no. English is the fallback for unknown or missing locales. */
export const routing = defineRouting({
  locales: ['en', 'no'],
  defaultLocale: 'en',
  localePrefix: 'always',
})

export type Locale = (typeof routing.locales)[number]

/** The language tag for <html lang>: Norwegian pages are written in bokmål. */
export const htmlLang = (locale: Locale): string => (locale === 'no' ? 'nb' : 'en')
