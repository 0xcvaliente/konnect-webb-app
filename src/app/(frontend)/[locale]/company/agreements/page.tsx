import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { AgreementList } from '@/components/app/agreements/AgreementList'
import { SiteShell } from '@/components/app/SiteShell'
import { routing } from '@/i18n/routing'
import { listOwnAgreements } from '@/lib/agreements/views'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'

// The company's agreements with Konnected: one per project, signed before it is published.
export const dynamic = 'force-dynamic'

export default async function CompanyAgreementsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const t = await getTranslations('AgreementSign')
  const agreements = await listOwnAgreements(payload, { ...user, collection: 'users' })

  return (
    <SiteShell {...companyShellProps(user, company)} title={t('listTitle')} lede={t('listLede')}>
      <AgreementList agreements={agreements} base="/company/agreements" />
    </SiteShell>
  )
}
