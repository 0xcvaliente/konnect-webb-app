import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { AUTH_MESSAGES, isAuthErrorCode } from '@/lib/auth/messages'

// Placeholder home page until the entry page card. It shows the sign-in state so the flow can be
// tried end to end. Nothing here is final design.
export const dynamic = 'force-dynamic'

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ auth_error?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('Home')
  const { auth_error } = await searchParams
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })

  return (
    <main>
      <h1>Konnected</h1>
      {isAuthErrorCode(auth_error) && <p role="alert">{AUTH_MESSAGES[auth_error][locale]}</p>}
      {user ? (
        <>
          <p>{t('signedInAs', { email: user.email, role: user.role })}</p>
          {user.role === 'pending' && <Link href="/choose-role">{t('chooseRole')}</Link>}
          <form method="post" action="/api/auth/logout">
            <button type="submit">{t('signOut')}</button>
          </form>
        </>
      ) : (
        // eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, needs a full navigation
        <a href="/api/auth/google/start">{t('continueWithGoogle')}</a>
      )}
    </main>
  )
}
