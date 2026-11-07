import {
  ArrowRightIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { OpenRow } from '@/components/app/dashboard/Parts'
import { PoolRow, WorkRow } from '@/components/app/team/WorkParts'
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
import { coveredBy, firstName, mineIds } from '@/lib/team/members'
import { POOL_AMBER_DAYS } from '@/lib/team/memberFields'
import { requireTeam } from '@/lib/team/session'
import { isDueSoon, isOverdue, itemsOf, loadToday, poolItems } from '@/lib/team/today'
import { calendarDaysBetween } from '@/lib/workingDays'

export const dynamic = 'force-dynamic'

/**
 * The team workspace home ("Today"). Signed-in team members land here. "My work" lists the
 * member's own items, most urgent first, with a working-day countdown where Konnected promised
 * one; the shared pool with "Take it"; and the items of a colleague they cover while that
 * colleague is away. "Everyone" shows the key numbers, what is overdue and due soon with each
 * owner, and every queue with its count and oldest item. Below both: the 2-step verification
 * notice and the way to the accounts.
 *
 * 2-step verification: team members sign in with Google only, and Google enforces 2-step
 * verification (through Google Workspace policy or the person's own Google account). The ID
 * token does not say reliably whether it was used (`amr` is not part of Google's documented
 * claims), so Konnected does not check it and only reminds the team here.
 */
export default async function TeamHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ view?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const view = (await searchParams).view === 'all' ? 'all' : 'mine'
  const t = await getTranslations('TeamHome')
  const tt = await getTranslations('TeamToday')
  const tRole = await getTranslations('Roles')
  const tq = await getTranslations('TeamApprovals')
  const tp = await getTranslations('TeamPayments')

  // The approval queues: how many items wait, and the oldest one.
  const todayData = await loadToday(payload, user)
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
    teamCounts(payload, user, todayData),
    listOpenProblems(payload, user),
    listProjectsWithoutMatch(payload, user),
  ])
  const problemList = problems ?? []
  const kickoffs = (todayData?.items ?? []).filter((i) => i.kind === 'kickoff')
  const noMatchList = noMatch ?? []
  const toCheck = (deliverables ?? []).filter((d) => d.section === 'check')
  // The open questions, oldest first, as Today built them (with owner and countdown).
  const questionList = (todayData?.items ?? [])
    .filter((i) => i.kind === 'question')
    .sort((a, b) => a.since.localeCompare(b.since))
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
      // Matched projects whose kick-off is not recorded yet (lib/kickoff).
      key: 'kickoff',
      href: kickoffs[0]?.href ?? '/team',
      label: t('queue.kickoff'),
      count: kickoffs.length,
      sub: kickoffs[0] ? t('firstKickoff', { name: kickoffs[0].title }) : t('queueEmpty'),
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
      // Ask Konnected: questions waiting for an answer (2 working days).
      key: 'questions',
      href: '/team/questions',
      label: t('queue.questions'),
      count: questionList.length,
      sub: questionList[0]
        ? t('firstQuestion', {
            name: questionList[0].title,
            waited: tq('waited', {
              count: Math.max(0, calendarDaysBetween(new Date(questionList[0].since), now)),
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

  // My work and Everyone (Kanban card "Today: My work and Everyone"): ownership sorts the work
  // into lists; every team member still sees everything under Everyone.
  const data = todayData ?? {
    today: '',
    team: [],
    items: [],
    numbers: {
      inProgress: 0,
      waitingForStudent: 0,
      agreementsOpen: 0,
      studentsReviewed: 0,
      activeCompanies: 0,
      pool: 0,
    },
  }
  const ownerOf = (id: number | null) => {
    const member = id ? data.team.find((m) => m.id === id) : undefined
    return member ? { id: member.id, name: member.name } : null
  }
  const me = data.team.find((m) => m.id === user.id)
  const myName = firstName(me?.name ?? user.name ?? user.email)
  const mineList = itemsOf(data.items, new Set([user.id]))
  const covering = coveredBy(data.team, user.id, data.today)
  const pool = poolItems(data.items)
  const mineCount = itemsOf(data.items, mineIds(data.team, user.id, data.today)).length
  const overdue = data.items.filter(isOverdue)
  const soon = data.items.filter(isDueSoon)
  const viewHref = (value: 'mine' | 'all') => (value === 'all' ? '/team?view=all' : '/team')
  // Away days: day and month only (they are always close to today).
  const shortDay = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/Oslo',
    })
  }
  const lede =
    view === 'mine'
      ? [
          tt('ledeMine', { mine: mineCount, pool: pool.length }),
          covering.length
            ? tt('ledeCover', {
                names: covering.map((m) => firstName(m.name)).join(', '),
                date: shortDay(covering[0]!.away!.until),
              })
            : '',
        ]
          .filter(Boolean)
          .join(' ')
      : tt('ledeAll', { count: data.items.length })

  return (
    <TeamShell
      current="today"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      title={tt('title')}
      lede={lede}
    >
      <nav
        aria-label={tt('viewLabel')}
        className="inline-flex max-w-full gap-1 justify-self-start overflow-x-auto rounded-full bg-surface-2 p-1"
      >
        {(['mine', 'all'] as const).map((key) => (
          <Link
            key={key}
            href={viewHref(key)}
            prefetch={false}
            aria-current={key === view ? 'page' : undefined}
            className="inline-flex min-h-11 items-center rounded-full px-4 text-[0.92rem] font-semibold whitespace-nowrap text-muted-foreground no-underline hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_3px_color-mix(in_srgb,var(--ink)_14%,transparent)] sm:min-h-[38px]"
          >
            {tt(`views.${key}`)}
          </Link>
        ))}
      </nav>

      {view === 'mine' ? (
        <div className="grid max-w-[1100px] items-start gap-5 lg:grid-cols-2">
          <Card className="gap-2">
            <CardTitle>{tt('yoursTitle', { name: myName })}</CardTitle>
            <CardDescription>{tt('yoursSub')}</CardDescription>
            {mineList.length ? (
              <ul className="grid">
                {mineList.map((item) => (
                  <WorkRow key={item.key} item={item} owner={null} showOwner={false} />
                ))}
              </ul>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{tt('yoursEmpty')}</p>
            )}
          </Card>
          <div className="grid min-w-0 gap-5">
            <Card className="gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{tt('poolTitle')}</CardTitle>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/team/members" prefetch={false}>
                    <UsersIcon aria-hidden="true" />
                    {tt('teamLink')}
                  </Link>
                </Button>
              </div>
              <CardDescription>{tt('poolBody', { days: POOL_AMBER_DAYS })}</CardDescription>
              {pool.length ? (
                <ul className="grid">
                  {pool.map((item) => (
                    <PoolRow key={item.key} item={item} />
                  ))}
                </ul>
              ) : (
                <p className="text-[0.9rem] text-muted-foreground">{tt('poolEmpty')}</p>
              )}
            </Card>
            {covering.map((other) => {
              const theirs = itemsOf(data.items, new Set([other.id]))
              const name = firstName(other.name)
              return (
                <Card key={other.id} className="gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{tt('coverTitle', { name })}</CardTitle>
                    <Badge tone="warn">
                      {tt('coverPill', {
                        from: shortDay(other.away!.from),
                        until: shortDay(other.away!.until),
                      })}
                    </Badge>
                  </div>
                  <CardDescription>
                    {tt('coverBody', { name, until: shortDay(other.away!.until) })}
                  </CardDescription>
                  {theirs.length ? (
                    <ul className="grid">
                      {theirs.map((item) => (
                        <WorkRow key={item.key} item={item} owner={ownerOf(item.ownerId)} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[0.9rem] text-muted-foreground">
                      {tt('coverEmpty', { name })}
                    </p>
                  )}
                </Card>
              )
            })}
          </div>
        </div>
      ) : (
        <>
          <Card className="max-w-[1100px] gap-3">
            <CardTitle>{tt('numbersTitle')}</CardTitle>
            <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
              {(
                [
                  'inProgress',
                  'waitingForStudent',
                  'agreementsOpen',
                  'studentsReviewed',
                  'activeCompanies',
                  'pool',
                ] as const
              ).map((key) => (
                <div
                  key={key}
                  className="flex flex-col gap-0.5 rounded-item bg-surface-2 px-3.5 py-3"
                >
                  <dt className="text-[0.85rem] text-muted-foreground">{tt(`numbers.${key}`)}</dt>
                  <dd className="order-first text-[1.5rem] leading-[1.1] font-semibold tabular-nums">
                    {data.numbers[key]}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>

          <div className="grid max-w-[1100px] items-start gap-5 lg:grid-cols-2">
            <Card className="gap-2">
              <CardTitle>{tt('overdueTitle')}</CardTitle>
              {overdue.length ? (
                <ul className="grid">
                  {overdue.map((item) => (
                    <WorkRow key={item.key} item={item} owner={ownerOf(item.ownerId)} />
                  ))}
                </ul>
              ) : (
                <p className="text-[0.9rem] text-muted-foreground">{tt('overdueEmpty')}</p>
              )}
            </Card>
            <Card className="gap-2">
              <CardTitle>{tt('soonTitle')}</CardTitle>
              {soon.length ? (
                <ul className="grid">
                  {soon.map((item) => (
                    <WorkRow key={item.key} item={item} owner={ownerOf(item.ownerId)} />
                  ))}
                </ul>
              ) : (
                <p className="text-[0.9rem] text-muted-foreground">{tt('soonEmpty')}</p>
              )}
            </Card>
          </div>

          <Card className="max-w-[1100px] gap-0 py-2 sm:py-3">
            <h2 className="sr-only">{tt('queuesTitle')}</h2>
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

          <div className="grid max-w-[1100px] gap-5 md:grid-cols-2">
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
        </>
      )}

      <Banner icon={ShieldCheckIcon} className="max-w-[1100px]">
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

      <div className="grid max-w-[1100px] gap-5 md:grid-cols-2">
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
