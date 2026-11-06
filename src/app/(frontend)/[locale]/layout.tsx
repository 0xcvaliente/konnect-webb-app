import '../globals.css'

import type { Metadata, Viewport } from 'next'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import type { ReactNode } from 'react'

import { Toaster } from '@/components/ui/sonner'
import { htmlLang, routing } from '@/i18n/routing'

export const metadata: Metadata = {
  title: 'Konnected',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#cbebdf' },
    { media: '(prefers-color-scheme: dark)', color: '#123a3a' },
  ],
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ locale: string }>
}) {
  // Every page is rendered per request: the proxy puts a fresh CSP nonce on each one, and Next.js
  // can only add that nonce to its scripts while rendering.
  await connection()
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)

  return (
    <html lang={htmlLang(locale)}>
      <body>
        <NextIntlClientProvider>
          {children}
          <Toaster />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
