import { ClockIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { QueueTab } from '@/lib/team/approvalFields'
import type { ActivityRow, Owner, QueueItem, QueueSection } from '@/lib/team/approvals'
import { cn } from '@/lib/utils'
import { calendarDaysBetween, type PromiseState } from '@/lib/workingDays'

/*
 * Pieces of the approval queue screen ("Konnected team daily work" mockup, Approvals): the list
 * with an owner and a countdown on each item, and the activity list under each item.
 */

const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

/** The item's owner on the team as a round avatar, or the shared pool. */
export async function OwnerChip({ owner }: { owner: Owner }) {
  const t = await getTranslations('TeamApprovals')
  if (!owner) return <Badge variant="tag">{t('pool')}</Badge>
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8rem] text-muted-foreground">
      <span
        aria-hidden="true"
        className="grid size-6 place-items-center rounded-full bg-primary text-[0.68rem] font-bold text-primary-foreground"
      >
        {initials(owner.name)}
      </span>
      <span className="sr-only">{t('owner', { name: owner.name })}</span>
      <span aria-hidden="true" className="max-w-[12ch] truncate">
        {owner.name.split(/[\s@]/)[0]}
      </span>
    </span>
  )
}

/** A promise countdown: days left, due today, or days late. */
export async function DueChip({ due }: { due: PromiseState }) {
  const t = await getTranslations('TeamApprovals.due')
  const tone = due.tone === 'late' ? 'bad' : due.tone === 'soon' ? 'warn' : 'ok'
  const label =
    due.left < 0
      ? t('late', { count: -due.left })
      : due.left === 0
        ? t('today')
        : t('left', { count: due.left })
  return (
    <Badge tone={tone}>
      <ClockIcon aria-hidden="true" />
      {label}
    </Badge>
  )
}

/** "waiting 3 days" from the item's start, in calendar days in Oslo. */
export async function waitedText(since: string): Promise<string> {
  const t = await getTranslations('TeamApprovals')
  return t('waited', { count: Math.max(0, calendarDaysBetween(new Date(since), new Date())) })
}

const SECTION_KEYS: Record<QueueTab, Partial<Record<QueueSection, string>>> = {
  companies: { review: 'companiesReview', waiting: 'companiesWaiting' },
  projects: { review: 'projectsReview', publish: 'projectsPublish', waiting: 'projectsWaiting' },
  students: { review: 'studentsReview', changed: 'studentsChanged', waiting: 'studentsWaiting' },
}

/**
 * The items of one tab, grouped by section, oldest first. Each row links to the item (and jumps
 * to the details below on a phone).
 */
export async function QueueList({
  tab,
  items,
  selectedId,
  hrefFor,
  mine,
}: {
  tab: QueueTab
  items: QueueItem[]
  selectedId: number | null
  hrefFor: (id: number) => string
  mine: boolean
}) {
  const t = await getTranslations('TeamApprovals')
  if (!items.length) {
    return (
      <p className="rounded-item border-[1.5px] border-dashed border-line p-4 text-[0.88rem] text-muted-foreground">
        {mine ? t('emptyMine') : t(`empty.${tab}`)}
      </p>
    )
  }
  const sections = (['review', 'publish', 'changed', 'waiting'] as const).filter((s) =>
    items.some((item) => item.section === s),
  )
  return (
    <div className="grid content-start gap-4">
      {await Promise.all(
        sections.map(async (section) => {
          const list = items.filter((item) => item.section === section)
          const headingId = `queue-${tab}-${section}`
          return (
            <section key={section} aria-labelledby={headingId} className="grid gap-2">
              <h2
                id={headingId}
                className="px-0.5 text-[0.82rem] font-semibold text-muted-foreground"
              >
                {t(`section.${SECTION_KEYS[tab][section]}`)}{' '}
                <span className="tabular-nums">({list.length})</span>
              </h2>
              <ul className="grid gap-2">
                {await Promise.all(
                  list.map(async (item) => {
                    const selected = item.id === selectedId
                    return (
                      <li key={item.id}>
                        <Link
                          href={hrefFor(item.id)}
                          prefetch={false}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'grid min-h-11 gap-1 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3 text-foreground no-underline transition-colors hover:bg-surface-2',
                            selected && 'border-transparent bg-tint hover:bg-tint',
                            section === 'waiting' && !selected && 'border-dashed',
                          )}
                        >
                          <b className="font-semibold [overflow-wrap:anywhere]">{item.title}</b>
                          <small className="text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                            {[item.subtitle, await waitedText(item.since)]
                              .filter(Boolean)
                              .join(', ')}
                          </small>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <OwnerChip owner={item.owner} />
                            {item.due && <DueChip due={item.due} />}
                            {item.applied ? (
                              <Badge tone="warn">{t('appliedTag', { count: item.applied })}</Badge>
                            ) : null}
                          </span>
                        </Link>
                      </li>
                    )
                  }),
                )}
              </ul>
            </section>
          )
        }),
      )}
    </div>
  )
}

/** What happened to the item, newest first. Notes are the team's own words. */
export async function ActivityCard({
  rows,
  describe,
}: {
  rows: ActivityRow[]
  describe: (row: ActivityRow) => string
}) {
  const t = await getTranslations('TeamApprovals')
  const format = await getFormatter()
  return (
    <Card className="gap-3">
      <CardTitle>{t('activityTitle')}</CardTitle>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{t('activityEmpty')}</p>
      ) : (
        <ul className="grid">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2.5 last:border-b-0"
            >
              <span className="min-w-0">
                <span className="block">{describe(row)}</span>
                {row.note && (
                  <span className="block text-[0.85rem] [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
                    {row.note}
                  </span>
                )}
                <span className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                  {row.actorName ?? t('system')}
                </span>
              </span>
              <time
                dateTime={row.createdAt}
                className="text-[0.85rem] text-muted-foreground tabular-nums"
              >
                {format.dateTime(new Date(row.createdAt), {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'Europe/Oslo',
                })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
