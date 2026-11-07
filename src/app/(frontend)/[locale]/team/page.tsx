import { ArrowRightIcon, ChevronRightIcon, ExternalLinkIcon, ShieldCheckIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { QUEUE_TABS } from '@/lib/team/approvalFields'
import { isOpen, listQueue } from '@/lib/team/approvals'
import { teamCounts } from '@/lib/team/counts'
import { requireTeam } from '@/lib/team/session'
import { calendarDaysBetween } from '@/lib/workingDays'

export const dynamic = 'force-dynamic'

/**
 * The team workspace home ("Today"). Signed-in team members land here. It lists the approval
 * queues with their counts and oldest item (the other queues come with their own cards), the
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

  // The approval queues: how many items wait, and the oldest one.
  const [queues, counts] = await Promise.all([
    Promise.all(
      QUEUE_TABS.map(async (tab) => {
        const items = ((await listQueue(payload, user, tab)) ?? []).filter(isOpen)
        return { tab, count: items.length, oldest: items[0] ?? null }
      }),
    ),
    teamCounts(payload, user),
  ])
  const now = new Date()

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
          {queues.map(({ tab, count, oldest }) => (
            <li key={tab} className="border-b border-line last:border-b-0">
              <Link
                href={tab === 'companies' ? '/team/approvals' : `/team/approvals?tab=${tab}`}
                prefetch={false}
                className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 py-3.5 text-foreground no-underline hover:[&_b]:underline"
              >
                <span className="min-w-[2ch] text-right text-[1.5rem] leading-none font-medium text-primary tabular-nums">
                  {count}
                </span>
                <span className="min-w-0">
                  <b className="block font-semibold">{t(`queue.${tab}`)}</b>
                  <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                    {oldest
                      ? t('oldest', {
                          name: oldest.title,
                          waited: tq('waited', {
                            count: Math.max(0, calendarDaysBetween(new Date(oldest.since), now)),
                          }),
                        })
                      : t('queueEmpty')}
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
