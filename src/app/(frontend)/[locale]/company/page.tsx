import { CircleCheckIcon, ClockIcon, PencilIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { CompanySteps } from '@/components/app/CompanySteps'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps, STATUS_TONE } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'

// The company's status page, the start of the company area. While Konnected reviews the company
// it is the "waiting for approval" page: what happens next, and a way to edit the details.
// Nothing else of the company area opens until approval (the menu shows it locked, and the
// project and file collections refuse a company that is not approved).
export const dynamic = 'force-dynamic'

export default async function CompanyStatusPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)

  const t = await getTranslations('CompanyStatus')
  const f = await getTranslations('CompanyFields')
  const format = await getFormatter()
  const status = company.status
  const approvedOn =
    status === 'approved' && company.approvedAt
      ? format.dateTime(new Date(company.approvedAt), { dateStyle: 'long' })
      : undefined
  const logoUrl = typeof company.logo === 'object' ? company.logo?.url : null

  const lede =
    status === 'pending'
      ? t('ledePending')
      : status === 'approved'
        ? t('ledeApproved')
        : t('ledeRejected')

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="status"
      title={t('title')}
      lede={lede}
    >
      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CompanyAvatar name={company.name} logoUrl={logoUrl} />
          <h2 className="min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere]">
            {company.name}
          </h2>
          <Badge tone={STATUS_TONE[status]}>{f(`status.${status}`)}</Badge>
        </div>
        {status === 'pending' && (
          <Banner tone="warn" icon={ClockIcon}>
            <p className="font-semibold">{t('pendingTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('pendingBody')}</p>
          </Banner>
        )}
        {status === 'approved' && (
          <Banner tone="ok" icon={CircleCheckIcon}>
            <p className="font-semibold">{t('approvedTitle')}</p>
            {approvedOn && (
              <p className="text-[0.88rem] text-muted-foreground">
                {t('approvedBody', { date: approvedOn })}
              </p>
            )}
          </Banner>
        )}
        {status === 'rejected' && (
          <Banner tone="bad">
            <p className="font-semibold">{t('rejectedTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('rejectedBody')}</p>
          </Banner>
        )}
        <CompanySteps status={status} approvedOn={approvedOn} row />
      </Card>

      {status === 'pending' ? (
        <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>{t('nextTitle')}</CardTitle>
            </CardHeader>
            <ol className="grid gap-3">
              {([1, 2, 3] as const).map((n) => (
                <li key={n} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
                  <span
                    aria-hidden="true"
                    className="grid size-7 place-items-center rounded-full bg-tint text-[0.8rem] font-bold text-tint-foreground"
                  >
                    {n}
                  </span>
                  <span className="grid gap-0.5">
                    <b className="font-semibold">{t(`next${n}Title`)}</b>
                    <span className="text-[0.88rem] text-muted-foreground">
                      {t(`next${n}Body`)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('editTitle')}</CardTitle>
              <CardDescription>{t('editBody')}</CardDescription>
            </CardHeader>
            <Button asChild variant="normal" className="w-full">
              <Link href="/company/profile">
                <PencilIcon aria-hidden="true" />
                {t('edit')}
              </Link>
            </Button>
            <p className="text-[0.85rem] text-muted-foreground">{t('lockedNote')}</p>
          </Card>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <Button asChild variant="secondary">
            <Link href="/company/profile">{t('view')}</Link>
          </Button>
        </div>
      )}
    </SiteShell>
  )
}
