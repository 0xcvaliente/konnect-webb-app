import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { SiteShell } from '@/components/app/SiteShell'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

import { Guide } from './Guide'

// Style guide for developers. Not part of the product: it does not exist in production.
export const dynamic = 'force-dynamic'

export default async function DesignPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('DesignGuide')
  const tRole = await getTranslations('Roles')

  return (
    <SiteShell
      role="student"
      current="home"
      user={{ name: 'ingrid.solberg@example.no', detail: tRole('student') }}
      title={t('title')}
      lede={t('lede')}
      actions={
        <Button variant="band" asChild>
          <Link href="/dev/design/team">{t('teamLink')}</Link>
        </Button>
      }
    >
      <Guide />
    </SiteShell>
  )
}
