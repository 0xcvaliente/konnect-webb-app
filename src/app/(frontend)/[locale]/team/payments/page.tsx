import { InfoIcon, PencilIcon, StickyNoteIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { TeamBilling } from '@/components/app/BillingForm'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { PAYMENT_TERMS_DAYS, VAT_RATE } from '@/lib/money'
import {
  PAYMENT_STATUS_TONE,
  PAYMENT_STATUSES,
  type PaymentFilter,
  readPaymentFilter,
} from '@/lib/payments/fields'
import { todayInOslo } from '@/lib/projects/fields'
import { teamCounts } from '@/lib/team/counts'
import { listPaymentLog, type PaymentRow } from '@/lib/team/payments'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'

import { OwnerChip } from '../approvals/QueueParts'
import { PaymentForm } from './PaymentForm'

export const dynamic = 'force-dynamic'

const paymentsHref = (filter: PaymentFilter, mine: boolean, row?: number) => {
  const params = new URLSearchParams()
  if (filter !== 'action') params.set('filter', filter)
  if (mine) params.set('who', 'mine')
  if (row) params.set('row', String(row))
  const query = params.toString()
  return `/team/payments${query ? `?${query}` : ''}`
}

/**
 * The payment log ("Konnected team daily work" mockup, Payments, the pilot state "by hand"): one
 * row per paid match with the price excluding VAT, 25 % VAT and the total; when the invoice was
 * sent and paid (14-day terms); when the student was paid in the monthly pay run, only after the
 * company paid; and the team's notes. Filters by where a row stands, and Mine / Everyone by the
 * company's owner on the team. Unpaid projects have no rows. Nothing is calculated for tax or
 * payroll: how students are paid is still open.
 */
export default async function TeamPaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ filter?: string; who?: string; row?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const search = await searchParams
  const filter = readPaymentFilter(search.filter)
  const mine = search.who === 'mine'
  const rowId = /^\d{1,10}$/.test(search.row ?? '') ? Number(search.row) : null

  const t = await getTranslations('TeamPayments')
  const tb = await getTranslations('Billing')
  const tRole = await getTranslations('Roles')
  const [log, counts, everything] = await Promise.all([
    listPaymentLog(payload, user, { filter, mine }),
    teamCounts(payload, user),
    rowId ? listPaymentLog(payload, user, { filter: 'all', mine: false }) : null,
  ])
  const rows = log?.rows ?? []
  const editing = rowId ? (everything?.rows.find((r) => r.id === rowId) ?? null) : null
  const format = await getFormatter()
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  const day = (value: string | null) => {
    if (!value) return null
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'medium',
      timeZone: 'Europe/Oslo',
    })
  }
  const statusLine = (row: PaymentRow) => {
    switch (row.status) {
      case 'not_released':
        return t('line.not_released')
      case 'to_invoice':
        return row.releasedAt
          ? t('line.to_invoice', { date: day(row.releasedAt.slice(0, 10)) ?? '' })
          : t('line.to_invoice_nodate')
      case 'invoice_sent':
        return t('line.invoice_sent', { date: day(row.due) ?? '' })
      case 'overdue':
        return t('line.overdue', { date: day(row.due) ?? '' })
      case 'student_to_pay':
        return t('line.student_to_pay')
      case 'settled':
        return t('line.settled')
    }
  }
  // Where the invoice goes: the company's billing details (the contact when none are given).
  const billingLine = (row: PaymentRow) =>
    row.billing
      ? [
          row.billing.invoiceEmail ?? tb('noEmail'),
          row.billing.invoiceReference
            ? tb('refShort', { ref: row.billing.invoiceReference })
            : null,
          row.billing.ehf ? tb('ehfShort') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null
  const filters: { key: PaymentFilter; count: number }[] = [
    { key: 'action', count: log?.action ?? 0 },
    { key: 'all', count: log?.total ?? 0 },
    ...PAYMENT_STATUSES.map((s) => ({ key: s as PaymentFilter, count: log?.counts[s] ?? 0 })),
  ]

  return (
    <TeamShell
      current="payments"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team', label: t('back') }}
      title={t('title')}
      lede={t('lede')}
    >
      <Card className="gap-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {(['to_invoice', 'overdue', 'student_to_pay', 'settled'] as const).map((s) => (
            <div key={s} className="grid gap-0.5">
              <dt className="text-[0.82rem] text-muted-foreground">{t(`nums.${s}`)}</dt>
              <dd className="text-[1.5rem] leading-none font-medium text-primary tabular-nums">
                {log?.counts[s] ?? 0}
              </dd>
            </div>
          ))}
        </dl>
        <Banner icon={InfoIcon}>
          <p className="text-[0.88rem]">
            {t('rules', { vat: VAT_RATE * 100, days: PAYMENT_TERMS_DAYS })}
          </p>
        </Banner>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label={t('filterLabel')} className="flex flex-wrap gap-2">
          {filters.map(({ key, count }) => (
            <Link
              key={key}
              href={paymentsHref(key, mine)}
              prefetch={false}
              aria-current={key === filter ? 'true' : undefined}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border-[1.5px] border-line bg-surface px-3.5 text-[0.85rem] font-semibold text-foreground no-underline hover:bg-surface-2 aria-[current=true]:border-transparent aria-[current=true]:bg-tint aria-[current=true]:text-tint-foreground sm:min-h-9"
            >
              {t(`filter.${key}`)}
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </Link>
          ))}
        </div>
        <div
          role="group"
          aria-label={t('whoLabel')}
          className="inline-flex rounded-full border-[1.5px] border-line p-0.5"
        >
          {([false, true] as const).map((value) => (
            <Link
              key={String(value)}
              href={paymentsHref(filter, value)}
              prefetch={false}
              aria-current={value === mine ? 'true' : undefined}
              className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[0.85rem] font-semibold text-muted-foreground no-underline aria-[current=true]:bg-tint aria-[current=true]:text-tint-foreground sm:min-h-8"
            >
              {value ? t('mine') : t('everyone')}
            </Link>
          ))}
        </div>
      </div>

      {editing && (
        <Card id="row" className="scroll-mt-4 gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="[overflow-wrap:anywhere]">
                {t('editTitle', { title: editing.title })}
              </CardTitle>
              <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                {t('who', { company: editing.companyName ?? '', student: editing.studentName })}
              </p>
            </div>
            <Badge tone={PAYMENT_STATUS_TONE[editing.status]}>
              {t(`status.${editing.status}`)}
            </Badge>
          </div>
          {editing.amounts ? (
            <dl className="grid max-w-sm grid-cols-[minmax(0,1fr)_max-content] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground">{t('col.price')}</dt>
              <dd className="text-right tabular-nums">{money(editing.amounts.price)}</dd>
              <dt className="text-muted-foreground">{t('col.vat', { rate: VAT_RATE * 100 })}</dt>
              <dd className="text-right tabular-nums">{money(editing.amounts.vat)}</dd>
              <dt className="border-t border-line pt-1.5 font-semibold">{t('col.total')}</dt>
              <dd className="border-t border-line pt-1.5 text-right font-semibold tabular-nums">
                {money(editing.amounts.total)}
              </dd>
            </dl>
          ) : (
            <Banner tone="warn">
              <p className="text-[0.88rem]">{t('noPrice')}</p>
            </Banner>
          )}
          {editing.companyId && editing.billing && (
            <section
              aria-labelledby="billing-title"
              className="grid gap-3 border-t border-line pt-4"
            >
              <h3 id="billing-title" className="text-[0.95rem] font-semibold">
                {tb('teamTitle', { company: editing.companyName ?? '' })}
              </h3>
              <TeamBilling
                companyId={editing.companyId}
                values={{
                  invoiceEmail: editing.billing.invoiceEmail ?? '',
                  invoiceReference: editing.billing.invoiceReference ?? '',
                  ehfInvoice: editing.billing.ehf,
                }}
                summary={
                  <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-0.5 text-[0.92rem] sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-1.5 [&_dd]:mb-1.5 sm:[&_dd]:mb-0">
                    <dt className="text-muted-foreground">{tb('invoiceEmail')}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {editing.billing.invoiceEmail ?? tb('noEmail')}
                    </dd>
                    <dt className="text-muted-foreground">{tb('reference')}</dt>
                    <dd className="[overflow-wrap:anywhere]">
                      {editing.billing.invoiceReference ?? t('none')}
                    </dd>
                    <dt className="text-muted-foreground">{tb('ehfLabel')}</dt>
                    <dd>{editing.billing.ehf ? tb('yes') : tb('no')}</dd>
                  </dl>
                }
              />
            </section>
          )}
          <PaymentForm
            // A new version (someone saved the row) loads the form again with what is stored.
            key={`${editing.id}-${editing.version}`}
            paymentId={editing.id}
            version={editing.version}
            today={todayInOslo()}
            values={{
              invoiceNumber: editing.invoiceNumber,
              invoiceSent: editing.invoiceSent,
              invoicePaid: editing.invoicePaid,
              studentPaid: editing.studentPaid,
              notes: editing.notes,
            }}
            backHref={paymentsHref(filter, mine)}
          />
        </Card>
      )}

      {rows.length === 0 ? (
        <Card className="gap-2">
          <CardTitle>{t(log?.total ? 'emptyFilterTitle' : 'emptyTitle')}</CardTitle>
          <p className="text-muted-foreground">{t(log?.total ? 'emptyFilterBody' : 'emptyBody')}</p>
        </Card>
      ) : (
        <Card className="gap-0 p-0 sm:p-0">
          <h2 className="sr-only">{t('tableTitle')}</h2>
          {/* Phones: one block per row. */}
          <ul className="grid min-[1000px]:hidden">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-2 border-b border-line px-[22px] py-4 last:border-b-0"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <b className="block font-semibold [overflow-wrap:anywhere]">{row.title}</b>
                    <small className="block text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                      {t('who', { company: row.companyName ?? '', student: row.studentName })}
                    </small>
                    {billingLine(row) && (
                      <small className="block text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                        {tb('invoiceTo', { to: billingLine(row)! })}
                      </small>
                    )}
                  </div>
                  <Badge tone={PAYMENT_STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Badge>
                </div>
                <p className="text-[0.85rem] text-muted-foreground">{statusLine(row)}</p>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.88rem]">
                  <dt className="text-muted-foreground">{t('col.total')}</dt>
                  <dd className="tabular-nums">
                    {row.amounts
                      ? t('totalWithParts', {
                          total: money(row.amounts.total),
                          price: money(row.amounts.price),
                          vat: money(row.amounts.vat),
                        })
                      : t('noPriceShort')}
                  </dd>
                  <dt className="text-muted-foreground">{t('col.invoiceSent')}</dt>
                  <dd className="tabular-nums">
                    {day(row.invoiceSent) ?? t('none')}
                    {row.invoiceNumber ? `, ${row.invoiceNumber}` : ''}
                  </dd>
                  <dt className="text-muted-foreground">{t('col.invoicePaid')}</dt>
                  <dd className="tabular-nums">{day(row.invoicePaid) ?? t('none')}</dd>
                  <dt className="text-muted-foreground">{t('col.studentPaid')}</dt>
                  <dd className="tabular-nums">{day(row.studentPaid) ?? t('none')}</dd>
                </dl>
                {row.notes && (
                  <p className="flex items-start gap-1.5 text-[0.85rem] text-muted-foreground">
                    <StickyNoteIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span className="line-clamp-2 [overflow-wrap:anywhere]">{row.notes}</span>
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <OwnerChip owner={row.owner} />
                  <Button asChild size="sm" variant="secondary">
                    <Link href={`${paymentsHref(filter, mine, row.id)}#row`} prefetch={false}>
                      <PencilIcon aria-hidden="true" className="size-4" />
                      {t('edit')}
                      <span className="sr-only">: {row.title}</span>
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          {/* Wide screens: the log as a table. */}
          <div className="hidden overflow-x-auto min-[1000px]:block">
            <table className="w-full border-collapse text-[0.9rem]">
              <thead>
                <tr className="text-left text-[0.8rem] text-muted-foreground">
                  <th scope="col" className="border-b border-line px-4 py-3 font-medium">
                    {t('col.project')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 text-right font-medium">
                    {t('col.price')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 text-right font-medium">
                    {t('col.vat', { rate: VAT_RATE * 100 })}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 text-right font-medium">
                    {t('col.total')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 font-medium">
                    {t('col.invoiceSent')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 font-medium">
                    {t('col.invoicePaid')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 font-medium">
                    {t('col.studentPaid')}
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-3 font-medium">
                    {t('col.status')}
                  </th>
                  <th scope="col" className="border-b border-line px-4 py-3">
                    <span className="sr-only">{t('edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={cn('align-top', row.id === rowId && 'bg-surface-2')}>
                    <th
                      scope="row"
                      className="border-b border-line px-4 py-3.5 text-left font-normal"
                    >
                      <b className="block font-semibold [overflow-wrap:anywhere]">{row.title}</b>
                      <small className="block text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                        {t('who', { company: row.companyName ?? '', student: row.studentName })}
                      </small>
                      {billingLine(row) && (
                        <small className="block max-w-[36ch] text-[0.8rem] [overflow-wrap:anywhere] text-muted-foreground">
                          {tb('invoiceTo', { to: billingLine(row)! })}
                        </small>
                      )}
                      <span className="mt-1.5 flex flex-wrap items-center gap-2">
                        <OwnerChip owner={row.owner} />
                        {row.notes && (
                          <span className="inline-flex max-w-[28ch] items-start gap-1 text-[0.8rem] text-muted-foreground">
                            <StickyNoteIcon
                              aria-hidden="true"
                              className="mt-0.5 size-3.5 shrink-0"
                            />
                            <span className="sr-only">{t('form.notes')}: </span>
                            <span className="line-clamp-1 [overflow-wrap:anywhere]">
                              {row.notes}
                            </span>
                          </span>
                        )}
                      </span>
                    </th>
                    <td className="border-b border-line px-3 py-3.5 text-right tabular-nums">
                      {row.amounts ? money(row.amounts.price) : t('none')}
                    </td>
                    <td className="border-b border-line px-3 py-3.5 text-right tabular-nums">
                      {row.amounts ? money(row.amounts.vat) : t('none')}
                    </td>
                    <td className="border-b border-line px-3 py-3.5 text-right font-semibold tabular-nums">
                      {row.amounts ? money(row.amounts.total) : t('none')}
                    </td>
                    <td className="border-b border-line px-3 py-3.5 tabular-nums whitespace-nowrap">
                      {day(row.invoiceSent) ?? t('none')}
                      {row.invoiceNumber && (
                        <small className="block text-[0.8rem] text-muted-foreground">
                          {row.invoiceNumber}
                        </small>
                      )}
                    </td>
                    <td className="border-b border-line px-3 py-3.5 tabular-nums whitespace-nowrap">
                      {day(row.invoicePaid) ?? t('none')}
                    </td>
                    <td className="border-b border-line px-3 py-3.5 tabular-nums whitespace-nowrap">
                      {day(row.studentPaid) ?? t('none')}
                    </td>
                    <td className="border-b border-line px-3 py-3.5">
                      <Badge tone={PAYMENT_STATUS_TONE[row.status]}>
                        {t(`status.${row.status}`)}
                      </Badge>
                      <small className="mt-1 block max-w-[22ch] text-[0.8rem] text-muted-foreground">
                        {statusLine(row)}
                      </small>
                    </td>
                    <td className="border-b border-line px-4 py-3.5 text-right">
                      <Button asChild size="sm" variant="secondary">
                        <Link href={`${paymentsHref(filter, mine, row.id)}#row`} prefetch={false}>
                          {t('edit')}
                          <span className="sr-only">: {row.title}</span>
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </TeamShell>
  )
}
