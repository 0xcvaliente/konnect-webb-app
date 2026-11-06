import config from '@payload-config'
import type { Metadata } from 'next'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { EntryShell } from '@/components/app/EntryShell'
import { routing } from '@/i18n/routing'
import { resetTokenEmail } from '@/lib/auth/emailSignIn'
import { PASSWORD_MIN } from '@/lib/auth/passwordRules'

import { ExpiredLink, NewPasswordForm } from '../../AuthPageForms'

// The token is in the address: never index the page. The site-wide Referrer-Policy
// (strict-origin-when-cross-origin) already keeps the path from other sites. A `no-referrer`
// policy here would stay on the document after the client-side redirect and make the next form
// post send `Origin: null`, which the sign-in routes refuse.
export const metadata: Metadata = { robots: { index: false } }
export const dynamic = 'force-dynamic'

/** Choose a new password with the link from a reset email. */
export default async function NewPasswordPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>
}) {
  const { locale, token } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('Reset')
  const email = await resetTokenEmail(await getPayload({ config }), token)
  return (
    <EntryShell title={t('newTitle')} lede={t('newLede', { min: PASSWORD_MIN })}>
      {email ? (
        <NewPasswordForm token={token} locale={locale} email={email} />
      ) : (
        <ExpiredLink
          title={t('invalidTitle')}
          body={t('invalidLede')}
          newLink={t('newLink')}
          newLinkHref="/reset-password"
          back={t('back')}
        />
      )}
    </EntryShell>
  )
}
