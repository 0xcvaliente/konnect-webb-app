import config from '@payload-config'
import { LockIcon, ReceiptTextIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'
import { PAYMENT_TERMS_DAYS, VAT_RATE } from '@/lib/money'
import type { CompanyInvoiceStatus } from '@/lib/payments/fields'
import { type CompanyInvoice, listCompanyInvoices } from '@/lib/payments/views'

// The company's Payments page ("Final pass" mockup, startup Payments, pilot): a read-only summary
// of its own invoices from Konnected, one per paid project with a selected student. Read as the
// company user with access control on: only its own rows and only the invoice fields come back.
// Nothing about what the student is paid, and no student details.
export const dynamic = 'force-dynamic'

const TONE: Record<CompanyInvoiceStatus, 'ok' | 'warn' | 'bad' | 'info' | 'mute'> = {
  not_sent: 'mute',
  sent: 'info',
  overdue: 'bad',
  paid: 'ok',
}

export default async function CompanyPaymentsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const t = await getTranslations('CompanyPayments')
  const shell = companyShellProps(user, company)

  if (company.status !== 'approved') {
    return (
      <SiteShell {...shell} current="payments" title={t('title')} lede={t('lede')}>
        <Card className="items-center py-10 text-center">
          <LockIcon aria-hidden="true" className="size-8 text-primary" />
          <p className="max-w-[46ch] text-muted-foreground">{t('locked')}</p>
          <Button asChild>
            <Link href="/company">{t('toStatus')}</Link>
          </Button>
        </Card>
      </SiteShell>
    )
  }

  const payload = await getPayload({ config })
  const invoices = (await listCompanyInvoices(payload, user)) ?? []
  const format = await getFormatter()
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  const day = (value: string | null) => {
    if (!value) return ''
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'medium',
      timeZone: 'Europe/Oslo',
    })
  }
  const line = (inv: CompanyInvoice) =>
    inv.status === 'paid'
      ? t('line.paid', { date: day(inv.paid) })
      : inv.status === 'overdue'
        ? t('line.overdue', { date: day(inv.due) })
        : inv.status === 'sent'
          ? t('line.sent', { sent: day(inv.sent), due: day(inv.due) })
          : t('line.not_sent')
  const open = invoices.filter((i) => i.status === 'sent' || i.status === 'overdue')

  return (
    <SiteShell {...shell} current="payments" title={t('title')} lede={t('lede')}>
      {invoices.length === 0 ? (
        <Card className="items-center py-10 text-center">
          <ReceiptTextIcon aria-hidden="true" className="size-8 text-primary" />
          <CardTitle>{t('emptyTitle')}</CardTitle>
          <p className="max-w-[50ch] text-muted-foreground">{t('emptyBody')}</p>
        </Card>
      ) : (
        <div className="grid gap-6 sm:gap-[26px]">
          {open.map((inv) => (
            <Card key={inv.id} className="gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="[overflow-wrap:anywhere]">
                    {inv.invoiceNumber
                      ? t('toPayNumber', { number: inv.invoiceNumber })
                      : t('toPay')}
                  </CardTitle>
                  <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                    {inv.title}
                  </p>
                </div>
                <Badge tone={TONE[inv.status]}>{t(`status.${inv.status}`)}</Badge>
              </div>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2">
                <dt className="text-muted-foreground">{t('amount')}</dt>
                <dd className="font-medium tabular-nums">
                  {inv.amounts
                    ? t('amountValue', {
                        total: money(inv.amounts.total),
                        rate: VAT_RATE * 100,
                      })
                    : t('none')}
                </dd>
                <dt className="text-muted-foreground">{t('due')}</dt>
                <dd className="font-medium tabular-nums">{day(inv.due)}</dd>
              </dl>
              <p className="text-[0.85rem] text-muted-foreground">
                {t('howToPay', { days: PAYMENT_TERMS_DAYS })}
              </p>
            </Card>
          ))}

          <Card className="gap-4">
            <CardTitle>{t('allTitle')}</CardTitle>
            <ul className="grid">
              {invoices.map((inv) => (
                <li
                  key={inv.id}
                  className="grid gap-2 border-b border-line py-3.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-6"
                >
                  <div className="grid min-w-0 gap-1">
                    <Link
                      href={`/company/projects/${inv.projectId}`}
                      className="font-semibold [overflow-wrap:anywhere]"
                    >
                      {inv.title}
                    </Link>
                    <p className="text-[0.85rem] text-muted-foreground">
                      {[
                        inv.invoiceNumber
                          ? t('invoiceNumber', { number: inv.invoiceNumber })
                          : null,
                        line(inv),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {inv.amounts && (
                      <p className="text-[0.82rem] text-muted-foreground tabular-nums">
                        {t('breakdown', {
                          price: money(inv.amounts.price),
                          vat: money(inv.amounts.vat),
                          rate: VAT_RATE * 100,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                    <span className="font-semibold tabular-nums">
                      {inv.amounts ? money(inv.amounts.total) : t('none')}
                    </span>
                    <Badge tone={TONE[inv.status]}>{t(`status.${inv.status}`)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[0.85rem] text-muted-foreground">{t('footnote')}</p>
          </Card>
        </div>
      )}
    </SiteShell>
  )
}
