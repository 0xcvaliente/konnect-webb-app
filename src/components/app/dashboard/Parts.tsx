import { ChevronRightIcon } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Link } from '@/i18n/navigation'
import { STAGE_OF, STAGES } from '@/lib/projects/display'
import type { ProjectStatus } from '@/lib/transitions'
import { cn } from '@/lib/utils'

/**
 * Small pieces the three dashboards share ("Final pass" mockups Student Home, Status and Today):
 * a row that opens an item (pill or count, title and line, chevron), and the seven-segment stage
 * track without its labels (the card lists the stage names once, under the rows).
 */

/** One row that opens something: a pill or number first, then the title and a short line. */
export function OpenRow({
  href,
  lead,
  title,
  sub,
}: {
  href: string
  lead?: ReactNode
  title: ReactNode
  sub?: ReactNode
}) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        href={href}
        prefetch={false}
        className={cn(
          'grid min-h-11 items-center gap-x-3.5 gap-y-1 py-3 text-foreground no-underline hover:[&_b]:underline',
          lead
            ? 'grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_auto]'
            : 'grid-cols-[minmax(0,1fr)_auto]',
        )}
      >
        {lead && <span className="col-span-2 sm:col-span-1">{lead}</span>}
        <span className="min-w-0">
          <b className="block font-semibold [overflow-wrap:anywhere]">{title}</b>
          {sub && (
            <small className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {sub}
            </small>
          )}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-[18px] text-muted-foreground" />
      </Link>
    </li>
  )
}

/** The seven stages as 8 px pill segments; the current one in `--data` (`--warn` when asked). */
export async function StageBars({
  status,
  warn = false,
}: {
  status: ProjectStatus
  warn?: boolean
}) {
  const t = await getTranslations('ProjectStatus')
  const at = STAGE_OF[status]
  if (at === undefined) return null
  return (
    <div
      role="img"
      aria-label={t('stageOf', {
        n: at + 1,
        total: STAGES.length,
        stage: t(`stage.${STAGES[at]}`),
      })}
      className="grid grid-cols-7 gap-1"
    >
      {STAGES.map((stage, i) => (
        <i
          key={stage}
          className={cn(
            'block h-2 rounded-full bg-surface-2',
            i < at && 'bg-[color-mix(in_srgb,var(--data)_38%,var(--surface))]',
            i === at && (warn || status === 'changes_requested' ? 'bg-warning' : 'bg-data'),
          )}
        />
      ))}
    </div>
  )
}

/** The stage names once, under a list of tracks. */
export async function StageKey() {
  const t = await getTranslations('ProjectStatus')
  const tc = await getTranslations('CompanyHome')
  return (
    <p className="text-[0.78rem] text-muted-foreground">
      <span className="sr-only">{tc('stagesLabel')}: </span>
      {STAGES.map((stage) => t(`stage.${stage}`)).join(' · ')}
    </p>
  )
}

/** The stage name of a status, for the line under a track. */
export async function stageName(status: ProjectStatus): Promise<string> {
  const t = await getTranslations('ProjectStatus')
  if (status === 'changes_requested' || status === 'rejected') return t(`pill.${status}`)
  const at = STAGE_OF[status]
  return at === undefined ? t(`pill.${status}`) : t(`stage.${STAGES[at]}`)
}
