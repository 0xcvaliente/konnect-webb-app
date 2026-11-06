import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { AgreementList } from '@/components/app/agreements/AgreementList'
import { SiteShell } from '@/components/app/SiteShell'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { listOwnAgreements } from '@/lib/agreements/views'
import type { User } from '@/payload-types'

// The student's agreements with Konnected: one per project they were selected for, signed after
// kick-off and before the work starts.
export const dynamic = 'force-dynamic'

export default async function StudentAgreementsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'student') return redirect({ href: '/', locale })
  const t = await getTranslations('AgreementSign')
  const agreements = await listOwnAgreements(payload, { ...(user as User), collection: 'users' })

  return (
    <SiteShell
      role="student"
      user={accountMenuUser(user as User)}
      title={t('listTitle')}
      lede={t('listLede')}
    >
      <AgreementList agreements={agreements} base="/student/agreements" />
    </SiteShell>
  )
}
