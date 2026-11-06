import { CircleCheckIcon, ClockIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { CompanySteps } from '@/components/app/CompanySteps'
import type { LogoInfo } from '@/components/app/LogoField'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { routing } from '@/i18n/routing'
import { companyShellProps, STATUS_TONE } from '@/lib/companies/display'
import { formatOrgNumber } from '@/lib/companies/fields'
import { requireOwnCompany } from '@/lib/companies/session'
import type { CompanyLogo } from '@/payload-types'

import { CompanyForm, type CompanyValues } from './CompanyForm'

// The company profile ("Final pass" mockup, Company profile): the details from the onboarding,
// editable while Konnected reviews them, and where the company stands. Read as the company user
// with access control on; the Server Action checks the session again.
export const dynamic = 'force-dynamic'

export default async function CompanyProfilePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)

  const t = await getTranslations('CompanyProfile')
  const ts = await getTranslations('CompanyStatus')
  const f = await getTranslations('CompanyFields')
  const format = await getFormatter()
  const status = company.status
  const approvedOn =
    status === 'approved' && company.approvedAt
      ? format.dateTime(new Date(company.approvedAt), { dateStyle: 'long' })
      : undefined

  const logoDoc =
    typeof company.logo === 'object' && company.logo ? (company.logo as CompanyLogo) : null
  const logo: LogoInfo | null = logoDoc
    ? { id: logoDoc.id, name: logoDoc.originalName ?? logoDoc.filename ?? 'logo', url: logoDoc.url }
    : null

  const values: CompanyValues = {
    name: company.name,
    orgNumber: company.orgNumber ? formatOrgNumber(company.orgNumber) : '',
    contactName: company.contactName ?? '',
    contactRole: company.contactRole ?? '',
    website: company.website ?? '',
    sector: company.sector ?? '',
    description: company.description ?? '',
  }

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      title={t('title')}
      lede={t('lede')}
      actions={
        <Badge tone={STATUS_TONE[status]} className="bg-surface">
          {f(`status.${status}`)}
        </Badge>
      }
      overlap={false}
    >
      {status === 'pending' && (
        <Banner tone="warn" icon={ClockIcon}>
          <p className="font-semibold">{ts('pendingTitle')}</p>
          <p className="text-[0.88rem] text-muted-foreground">{ts('pendingBody')}</p>
        </Banner>
      )}
      {status === 'approved' && (
        <Banner tone="ok" icon={CircleCheckIcon}>
          <p className="font-semibold">{ts('approvedTitle')}</p>
          {approvedOn && (
            <p className="text-[0.88rem] text-muted-foreground">
              {ts('approvedBody', { date: approvedOn })}
            </p>
          )}
        </Banner>
      )}
      {status === 'rejected' && (
        <Banner tone="bad">
          <p className="font-semibold">{ts('rejectedTitle')}</p>
          <p className="text-[0.88rem] text-muted-foreground">{ts('rejectedBody')}</p>
        </Banner>
      )}

      <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <CompanyForm values={values} logo={logo} status={status} />
        <Card className="md:sticky md:top-24">
          <CardHeader>
            <CardTitle>{t('statusTitle')}</CardTitle>
          </CardHeader>
          <CompanySteps status={status} approvedOn={approvedOn} />
          {status === 'pending' && (
            <Button type="button" variant="secondary" className="w-full whitespace-normal" disabled>
              {t('submitAfterApproval')}
            </Button>
          )}
        </Card>
      </div>
    </SiteShell>
  )
}
