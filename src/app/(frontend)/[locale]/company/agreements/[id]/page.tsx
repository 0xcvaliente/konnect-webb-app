import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { PartyAgreement } from '@/components/app/agreements/PartyAgreement'
import { SiteShell } from '@/components/app/SiteShell'
import { routing } from '@/i18n/routing'
import { loadAgreementView } from '@/lib/agreements/views'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'

// One company agreement: read the PDF, then sign (mockup "Agreement" for startups). Read as the
// company user with access control on; anything else is "not found".
export const dynamic = 'force-dynamic'

export default async function CompanyAgreementPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const view = await loadAgreementView(payload, { ...user, collection: 'users' }, Number(id))
  if (!view || view.agreement.kind !== 'company') notFound()
  const t = await getTranslations('AgreementSign')

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      title={t('title')}
      lede={view.agreement.title}
      overlap={false}
    >
      <PartyAgreement view={view} role="company" companyName={company.name} />
    </SiteShell>
  )
}
