import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { TeamShell } from '@/components/app/TeamShell'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

import { Guide } from '../Guide'

// The style guide inside the team workspace layout. Does not exist in production.
export const dynamic = 'force-dynamic'

export default async function DesignTeamPage({ params }: { params: Promise<{ locale: string }> }) {
  if (process.env.NODE_ENV === 'production') notFound()
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('DesignGuide')
  const tRole = await getTranslations('Roles')

  return (
    <TeamShell
      current="today"
      counts={{
        today: 7,
        approvals: 4,
        matching: 2,
        agreements: 3,
        deliverables: 1,
        questions: 2,
        payments: 5,
        dataRequests: 1,
      }}
      user={{ name: 'clifford@konnected.no', detail: tRole('admin') }}
      title={t('teamTitle')}
      lede={t('teamLede')}
      actions={
        <Button variant="secondary" asChild>
          <Link href="/dev/design">{t('siteLink')}</Link>
        </Button>
      }
    >
      <Guide />
    </TeamShell>
  )
}
