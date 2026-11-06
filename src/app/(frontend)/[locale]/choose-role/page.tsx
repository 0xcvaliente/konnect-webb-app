import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

// Plain placeholder for the role step after the first sign-in. Styling comes with the design base.
export const dynamic = 'force-dynamic'

export default async function ChooseRolePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('ChooseRole')
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'pending') return redirect({ href: '/', locale })

  return (
    <main>
      <h1>{t('title')}</h1>
      <form method="post" action="/api/auth/role">
        <button type="submit" name="role" value="student">
          {t('student')}
        </button>
        <button type="submit" name="role" value="company">
          {t('company')}
        </button>
      </form>
    </main>
  )
}
