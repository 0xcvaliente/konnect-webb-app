import { CircleCheckIcon, ClockIcon, InfoIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import type { Company } from '@/payload-types'

import { Banner } from './Banner'

/**
 * Where Konnected's review of the company stands, for the company's status and profile pages:
 * waiting, more information asked (with Konnected's note), approved, or not approved (with the
 * reason, and whether the company may correct its details and send them once more).
 */
export async function CompanyReviewBanner({
  company,
  where,
}: {
  company: Pick<Company, 'status' | 'approvedAt' | 'noteToCompany' | 'infoRequestedAt' | 'resentAt'>
  /** The profile page holds the form; the status page points to it. */
  where: 'status' | 'profile'
}) {
  const t = await getTranslations('CompanyStatus')
  const format = await getFormatter()
  const day = (value: string) =>
    format.dateTime(new Date(value), { dateStyle: 'long', timeZone: 'Europe/Oslo' })
  const note = company.noteToCompany?.trim()
  const quote = note ? (
    <blockquote className="my-1 border-l-[3px] border-[color-mix(in_srgb,var(--tone)_45%,transparent)] py-0.5 pl-3 text-[0.92rem] [overflow-wrap:anywhere] whitespace-pre-line">
      {note}
    </blockquote>
  ) : null

  if (company.status === 'pending' && company.infoRequestedAt) {
    return (
      <Banner tone="warn" icon={InfoIcon} role="status">
        <p className="font-semibold">{t('infoTitle')}</p>
        {quote}
        <p className="text-[0.88rem] text-muted-foreground">
          {where === 'profile' ? t('infoBodyProfile') : t('infoBodyStatus')}
        </p>
      </Banner>
    )
  }
  if (company.status === 'pending') {
    return (
      <Banner tone="warn" icon={ClockIcon}>
        <p className="font-semibold">{t('pendingTitle')}</p>
        <p className="text-[0.88rem] text-muted-foreground">
          {company.resentAt ? t('resentBody', { date: day(company.resentAt) }) : t('pendingBody')}
        </p>
      </Banner>
    )
  }
  if (company.status === 'approved') {
    return (
      <Banner tone="ok" icon={CircleCheckIcon}>
        <p className="font-semibold">{t('approvedTitle')}</p>
        {company.approvedAt && (
          <p className="text-[0.88rem] text-muted-foreground">
            {t('approvedBody', { date: day(company.approvedAt) })}
          </p>
        )}
      </Banner>
    )
  }
  const canResend = !company.resentAt
  return (
    <Banner tone="bad">
      <p className="font-semibold">{t('rejectedTitle')}</p>
      {note && <p className="text-[0.88rem] text-muted-foreground">{t('rejectedReason')}</p>}
      {quote}
      <p className="text-[0.88rem] text-muted-foreground">
        {canResend
          ? where === 'profile'
            ? t('rejectedResendProfile')
            : t('rejectedResendStatus')
          : t('rejectedBody')}
      </p>
    </Banner>
  )
}
