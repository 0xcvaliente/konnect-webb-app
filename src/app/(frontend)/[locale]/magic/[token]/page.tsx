import config from '@payload-config'
import type { Metadata } from 'next'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { EntryShell } from '@/components/app/EntryShell'
import { routing } from '@/i18n/routing'
import { magicLinkUsable } from '@/lib/auth/emailSignIn'

import { ExpiredLink, MagicLinkForm } from '../../AuthPageForms'

// The token is in the address: never index the page. The site-wide Referrer-Policy
// (strict-origin-when-cross-origin) already keeps the path from other sites. A `no-referrer`
// policy here would stay on the document after the client-side redirect and make the next form
// post send `Origin: null`, which the sign-in routes refuse.
export const metadata: Metadata = { robots: { index: false } }
export const dynamic = 'force-dynamic'

/**
 * The page a sign-in link opens. Opening it signs nobody in (mail scanners open links); the
 * button POSTs the token, which works once.
 */
export default async function MagicLinkPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>
}) {
  const { locale, token } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('MagicLink')
  const usable = await magicLinkUsable(await getPayload({ config }), token)
  return (
    <EntryShell title={t('title')} lede={t('lede')}>
      {usable ? (
        <MagicLinkForm token={token} locale={locale} />
      ) : (
        <ExpiredLink
          title={t('expiredTitle')}
          body={t('expiredLede')}
          newLink={t('newLink')}
          newLinkHref="/"
          back={t('back')}
        />
      )}
    </EntryShell>
  )
}
