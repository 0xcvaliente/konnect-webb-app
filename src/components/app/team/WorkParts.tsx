import { ChevronRightIcon, ClockIcon } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { OwnerChip } from '@/app/(frontend)/[locale]/team/approvals/QueueParts'
import { Badge } from '@/components/ui/badge'
import { Link } from '@/i18n/navigation'
import type { Owner } from '@/lib/team/approvals'
import type { WorkItem } from '@/lib/team/today'
import type { PromiseState } from '@/lib/workingDays'

import { TakeButton } from './TeamForms'

/*
 * Rows of the team's Today ("Final pass" mockup, Today): each open item with its owner (or the
 * shared pool) and a countdown where Konnected promises a number of working days.
 */

/** A countdown chip: days left, due today, or days late (working days). */
export async function DueBadge({ due }: { due: PromiseState }) {
  const t = await getTranslations('TeamToday.due')
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

/** How long a shared-pool item has waited; amber after 2 working days. */
export async function PoolBadge({ pool }: { pool: NonNullable<WorkItem['pool']> }) {
  const t = await getTranslations('TeamToday')
  return (
    <Badge tone={pool.amber ? 'warn' : 'mute'}>
      <ClockIcon aria-hidden="true" />
      {t('poolWaited', { count: pool.waited })}
    </Badge>
  )
}

/** One open item that links to where the team acts on it. */
export async function WorkRow({
  item,
  owner,
  showOwner = true,
}: {
  item: WorkItem
  owner: Owner
  showOwner?: boolean
}) {
  const t = await getTranslations('TeamToday')
  const kind = t(`kind.${item.kind}`)
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        href={item.href}
        prefetch={false}
        className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-3 text-foreground no-underline hover:[&_b]:underline"
      >
        <span className="grid min-w-0 gap-1">
          <b className="block font-semibold [overflow-wrap:anywhere]">{item.title}</b>
          <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
            {item.detail ? t('itemSub', { kind, detail: item.detail }) : kind}
          </small>
          {(showOwner || item.due || item.pool) && (
            <span className="flex flex-wrap items-center gap-2 pt-0.5">
              {showOwner && <OwnerChip owner={owner} />}
              {item.due ? (
                <DueBadge due={item.due} />
              ) : item.pool ? (
                <PoolBadge pool={item.pool} />
              ) : null}
            </span>
          )}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-[18px] text-muted-foreground" />
      </Link>
    </li>
  )
}

/** A shared-pool item with its "Take it" button. */
export async function PoolRow({ item }: { item: WorkItem }) {
  const t = await getTranslations('TeamToday')
  if (!item.pool) return null
  const kind = t(`kind.${item.kind}`)
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-b border-line py-3 last:border-b-0">
      <span className="grid min-w-0 gap-1">
        <Link href={item.href} prefetch={false} className="font-semibold [overflow-wrap:anywhere]">
          {item.title}
        </Link>
        <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
          {item.detail ? t('itemSub', { kind, detail: item.detail }) : kind}
        </small>
        <span className="flex flex-wrap items-center gap-2 pt-0.5">
          {item.due ? <DueBadge due={item.due} /> : <PoolBadge pool={item.pool} />}
        </span>
      </span>
      <TakeButton collection={item.pool.collection} id={item.pool.id} label={item.title} />
    </li>
  )
}
