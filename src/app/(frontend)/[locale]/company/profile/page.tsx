import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { BillingForm } from '@/components/app/BillingForm'
import { CompanyReviewBanner } from '@/components/app/CompanyReviewBanner'
import { CompanySteps } from '@/components/app/CompanySteps'
import type { LogoInfo } from '@/components/app/LogoField'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { billingOf } from '@/lib/companies/billing'
import { companyShellProps, STATUS_TONE } from '@/lib/companies/display'
import { formatOrgNumber } from '@/lib/companies/fields'
import { requireOwnCompany } from '@/lib/companies/session'
import { PAYMENT_TERMS_DAYS, VAT_RATE } from '@/lib/money'
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
  const tb = await getTranslations('Billing')
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
      <CompanyReviewBanner company={company} where="profile" />

      <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6 sm:gap-[26px]">
          <CompanyForm
            values={values}
            logo={logo}
            status={status}
            canResend={status === 'rejected' && !company.resentAt}
            answering={status === 'pending' && Boolean(company.infoRequestedAt)}
          />
          <Card id="billing" className="scroll-mt-24">
            <CardHeader>
              <CardTitle>{tb('title')}</CardTitle>
              <p className="text-[0.9rem] text-muted-foreground">
                {tb('body', { vat: VAT_RATE * 100, days: PAYMENT_TERMS_DAYS })}
              </p>
            </CardHeader>
            {status === 'rejected' ? (
              <p className="text-[0.9rem] text-muted-foreground">{tb('locked')}</p>
            ) : (
              <BillingForm as="company" values={billingOf(company)} />
            )}
          </Card>
        </div>
        <Card className="md:sticky md:top-24">
          <CardHeader>
            <CardTitle>{t('statusTitle')}</CardTitle>
          </CardHeader>
          <CompanySteps
            status={status}
            approvedOn={approvedOn}
            infoRequested={Boolean(company.infoRequestedAt)}
          />
          {status === 'pending' && (
            <>
              <Button asChild className="w-full whitespace-normal">
                <Link href="/company/projects/new">{t('startDraft')}</Link>
              </Button>
              <p className="text-[0.85rem] text-muted-foreground">{t('startDraftHint')}</p>
            </>
          )}
          {status === 'approved' && (
            <Button asChild className="w-full whitespace-normal">
              <Link href="/company/projects/new">{t('submitProject')}</Link>
            </Button>
          )}
        </Card>
      </div>
    </SiteShell>
  )
}
