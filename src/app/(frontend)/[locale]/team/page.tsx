import { ArrowRightIcon, ChevronRightIcon, ExternalLinkIcon, ShieldCheckIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { OpenRow } from '@/components/app/dashboard/Parts'
import { Badge } from '@/components/ui/badge'
import { TeamShell } from '@/components/app/TeamShell'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { QUEUE_TABS } from '@/lib/team/approvalFields'
import { isOpen, listQueue } from '@/lib/team/approvals'
import { teamCounts } from '@/lib/team/counts'
import { listDeliverableQueue } from '@/lib/team/deliverables'
import { listMatchingQueue } from '@/lib/team/matching'
import { listPaymentLog } from '@/lib/team/payments'
import { listOpenProblems, listProjectsWithoutMatch } from '@/lib/team/projects'
import { requireTeam } from '@/lib/team/session'
import { calendarDaysBetween } from '@/lib/workingDays'

export const dynamic = 'force-dynamic'

/**
 * The team workspace home ("Today"). Signed-in team members land here. It lists the approval
 * queues with their counts and oldest item, the applications to decide in Matching, the hand-ins
 * to check in Deliverables and the payment log rows that need the team, the
 * 2-step verification notice and the way to the accounts.
 *
 * 2-step verification: team members sign in with Google only, and Google enforces 2-step
 * verification (through Google Workspace policy or the person's own Google account). The ID
 * token does not say reliably whether it was used (`amr` is not part of Google's documented
 * claims), so Konnected does not check it and only reminds the team here.
 */
export default async function TeamHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const t = await getTranslations('TeamHome')
  const tRole = await getTranslations('Roles')
  const tq = await getTranslations('TeamApprovals')
  const tp = await getTranslations('TeamPayments')

  // The approval queues: how many items wait, and the oldest one.
  const [queues, matching, deliverables, payments, counts, problems, noMatch] = await Promise.all([
    Promise.all(
      QUEUE_TABS.map(async (tab) => {
        const items = ((await listQueue(payload, user, tab)) ?? []).filter(isOpen)
        return { tab, count: items.length, oldest: items[0] ?? null }
      }),
    ),
    listMatchingQueue(payload, user),
    listDeliverableQueue(payload, user),
    listPaymentLog(payload, user, { filter: 'action' }),
    teamCounts(payload, user),
    listOpenProblems(payload, user),
    listProjectsWithoutMatch(payload, user),
  ])
  const problemList = problems ?? []
  const noMatchList = noMatch ?? []
  const toCheck = (deliverables ?? []).filter((d) => d.section === 'check')
  const firstPayment = payments?.rows[0] ?? null
  const now = new Date()
  const format = await getFormatter()
  const firstToDecide = matching?.[0] ?? null
  const day = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'medium',
      timeZone: 'Europe/Oslo',
    })
  }
  const rows = [
    ...queues.map(({ tab, count, oldest }) => ({
      key: tab,
      href: tab === 'companies' ? '/team/approvals' : `/team/approvals?tab=${tab}`,
      label: t(`queue.${tab}`),
      count,
      sub: oldest
        ? t('oldest', {
            name: oldest.title,
            waited: tq('waited', {
              count: Math.max(0, calendarDaysBetween(new Date(oldest.since), now)),
            }),
          })
        : t('queueEmpty'),
    })),
    {
      key: 'matching',
      href: '/team/matching',
      label: t('queue.matching'),
      count: matching?.length ?? 0,
      sub: firstToDecide
        ? firstToDecide.decideBy
          ? t('decideBy', { name: firstToDecide.title, date: day(firstToDecide.decideBy) })
          : firstToDecide.title
        : t('queueEmpty'),
    },
    {
      key: 'problems',
      href: problemList[0] ? `/team/projects/${problemList[0].projectId}` : '/team',
      label: t('queue.problems'),
      count: problemList.length,
      sub: problemList[0]
        ? t('firstProblem', {
            name: problemList[0].title,
            kind: t(`kindShort.${problemList[0].kind}`),
          })
        : t('queueEmpty'),
    },
    {
      key: 'noMatch',
      href: noMatchList[0] ? `/team/projects/${noMatchList[0].projectId}` : '/team',
      label: t('queue.noMatch'),
      count: noMatchList.length,
      sub: noMatchList[0]
        ? t('firstNoMatch', { name: noMatchList[0].title, date: day(noMatchList[0].closedOn) })
        : t('queueEmpty'),
    },
    {
      key: 'deliverables',
      href: '/team/deliverables',
      label: t('queue.deliverables'),
      count: toCheck.length,
      sub: toCheck[0]
        ? t('oldest', {
            name: toCheck[0].title,
            waited: tq('waited', {
              count: Math.max(0, calendarDaysBetween(new Date(toCheck[0].since), now)),
            }),
          })
        : t('queueEmpty'),
    },
    {
      key: 'payments',
      href: '/team/payments',
      label: t('queue.payments'),
      count: payments?.action ?? 0,
      sub: firstPayment
        ? t('firstPayment', {
            name: firstPayment.title,
            status: tp(`status.${firstPayment.status}`),
          })
        : t('queueEmpty'),
    },
  ]

  return (
    <TeamShell
      current="today"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      title={t('title')}
      lede={t('lede')}
    >
      <Card className="max-w-[880px] gap-0 py-2 sm:py-3">
        <h2 className="sr-only">{t('queuesTitle')}</h2>
        <ul className="grid">
          {rows.map((row) => (
            <li key={row.key} className="border-b border-line last:border-b-0">
              <Link
                href={row.href}
                prefetch={false}
                className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 py-3.5 text-foreground no-underline hover:[&_b]:underline"
              >
                <span className="min-w-[2ch] text-right text-[1.5rem] leading-none font-medium text-primary tabular-nums">
                  {row.count}
                </span>
                <span className="min-w-0">
                  <b className="block font-semibold">{row.label}</b>
                  <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                    {row.sub}
                  </small>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-[18px] text-muted-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid max-w-[880px] gap-5 md:grid-cols-2">
        <Card className="gap-2">
          <CardTitle>{t('problemsTitle')}</CardTitle>
          {problemList.length ? (
            <ul className="grid">
              {problemList.map((p) => (
                <OpenRow
                  key={p.id}
                  href={`/team/projects/${p.projectId}`}
                  lead={<Badge tone="warn">{t(`kindShort.${p.kind}`)}</Badge>}
                  title={p.title}
                  sub={t('reportedOn', {
                    company: p.companyName,
                    date: format.dateTime(new Date(p.since), {
                      dateStyle: 'medium',
                      timeZone: 'Europe/Oslo',
                    }),
                  })}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[0.9rem] text-muted-foreground">{t('problemsEmpty')}</p>
          )}
        </Card>
        <Card className="gap-2">
          <CardTitle>{t('noMatchTitle')}</CardTitle>
          {noMatchList.length ? (
            <ul className="grid">
              {noMatchList.map((p) => (
                <OpenRow
                  key={p.projectId}
                  href={`/team/projects/${p.projectId}`}
                  title={p.title}
                  sub={t('noMatchSub', {
                    company: p.companyName,
                    date: day(p.closedOn),
                    count: p.open,
                  })}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[0.9rem] text-muted-foreground">{t('noMatchEmpty')}</p>
          )}
        </Card>
      </div>

      <Banner icon={ShieldCheckIcon} className="max-w-[880px]">
        <p className="font-semibold">{t('twoStepTitle')}</p>
        <p className="text-[0.88rem] text-muted-foreground">{t('twoStepBody')}</p>
        <a
          href="https://myaccount.google.com/security"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex min-h-11 items-center gap-1.5 font-semibold sm:min-h-0"
        >
          {t('twoStepLink')}
          <ExternalLinkIcon aria-hidden="true" className="size-4" />
        </a>
      </Banner>

      <div className="grid max-w-[880px] gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('accountsTitle')}</CardTitle>
            <CardDescription>{t('accountsBody')}</CardDescription>
          </CardHeader>
          <div>
            <Button asChild variant="normal">
              <Link href="/team/users">
                {t('accountsLink')}
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('panelTitle')}</CardTitle>
            <CardDescription>{t('panelBody')}</CardDescription>
          </CardHeader>
          <div>
            <Button asChild variant="secondary">
              {/* Payload's own panel has its own root layout: a full navigation, not next-intl's. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- separate app */}
              <a href="/admin">{t('panelLink')}</a>
            </Button>
          </div>
        </Card>
      </div>
    </TeamShell>
  )
}
