import { WalletIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { STUDENT_PAYOUT_TONE } from '@/lib/payments/fields'
import { listStudentPayments } from '@/lib/payments/views'
import { requireStudent } from '@/lib/students/session'

// The student's Payments page ("Final pass" mockup, student Payments; Kanban card "Student
// payments page (status only)"): for each paid project Konnected selected the student for, where
// their pay stands: waiting for the company to pay Konnected, in the next monthly pay run, or paid
// on a day. The only amount is the student's own pay, if Konnected set it; nothing about the
// company's invoice or price, and nothing about tax or payroll (how students are paid is still
// open). Read as the student with access control on.
export const dynamic = 'force-dynamic'

export default async function StudentPaymentsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const t = await getTranslations('StudentPayments')
  const payments = (await listStudentPayments(payload, user)) ?? []
  const format = await getFormatter()
  const day = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'long',
      timeZone: 'Europe/Oslo',
    })
  }

  return (
    <SiteShell role="student" current="payments" user={account} title={t('title')} lede={t('lede')}>
      {payments.length === 0 ? (
        <Card className="items-center py-10 text-center">
          <WalletIcon aria-hidden="true" className="size-8 text-primary" />
          <CardTitle>{t('emptyTitle')}</CardTitle>
          <p className="max-w-[50ch] text-muted-foreground">{t('emptyBody')}</p>
          <Button asChild variant="secondary">
            <Link href="/student/projects">{t('toProjects')}</Link>
          </Button>
        </Card>
      ) : (
        <div className="grid gap-6 sm:gap-[26px]">
          <Card className="gap-4">
            <CardTitle>{t('listTitle')}</CardTitle>
            <ul className="grid">
              {payments.map((p) => (
                <li
                  key={p.id}
                  className="grid gap-1.5 border-b border-line py-3.5 first:pt-0 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-6"
                >
                  <div className="grid min-w-0 gap-0.5">
                    {p.applicationId ? (
                      <Link
                        href={`/student/applications/${p.applicationId}`}
                        className="font-semibold [overflow-wrap:anywhere]"
                      >
                        {p.title}
                      </Link>
                    ) : (
                      <b className="font-semibold [overflow-wrap:anywhere]">{p.title}</b>
                    )}
                    {p.companyName && (
                      <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                        {p.companyName}
                      </p>
                    )}
                    <p className="text-[0.88rem] text-muted-foreground">
                      {p.status === 'paid' && p.paidOn
                        ? t('paidOn', { date: day(p.paidOn) })
                        : t(`line.${p.status}`, { company: p.companyName ?? t('theCompany') })}
                    </p>
                    {p.pay !== null && (
                      <p className="text-[0.88rem] tabular-nums">
                        {t('pay', {
                          amount: format.number(p.pay, {
                            style: 'currency',
                            currency: 'NOK',
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          }),
                        })}
                      </p>
                    )}
                  </div>
                  <div>
                    <Badge tone={STUDENT_PAYOUT_TONE[p.status]}>{t(`status.${p.status}`)}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="gap-2">
            <CardTitle>{t('detailsTitle')}</CardTitle>
            <p className="text-[0.9rem] text-muted-foreground">{t('detailsBody')}</p>
          </Card>
        </div>
      )}
    </SiteShell>
  )
}
