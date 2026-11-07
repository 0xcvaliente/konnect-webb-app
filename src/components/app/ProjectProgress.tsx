import { CheckIcon, XIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import type { HistoryEntry } from '@/lib/projects/project'
import { STAGE_OF, STAGES } from '@/lib/projects/display'
import type { ProjectStatus } from '@/lib/transitions'
import { cn } from '@/lib/utils'

/**
 * The seven-stage progress track ("Final pass" mockup, Progress): 8 px pill segments, done =
 * `--data` at 38 %, current = `--data` (`--warn` when changes are asked), with the named stages
 * under it and the current one bold. A rejected project is not on the track.
 */
export async function ProjectTrack({ status }: { status: ProjectStatus }) {
  const t = await getTranslations('ProjectStatus')
  const at = STAGE_OF[status]
  if (at === undefined)
    return <p className="text-[0.88rem] text-muted-foreground">{t('offTrack')}</p>
  const warn = status === 'changes_requested'
  return (
    <div className="grid gap-2.5">
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
              i === at && (warn ? 'bg-warning' : 'bg-data'),
            )}
          />
        ))}
      </div>
      <p className="text-[0.88rem] text-muted-foreground">
        {t('stageOf', { n: at + 1, total: STAGES.length, stage: t(`stage.${STAGES[at]}`) })}
      </p>
      <ol
        aria-hidden="true"
        className="flex flex-wrap gap-x-1 text-[0.78rem] text-muted-foreground"
      >
        {STAGES.map((stage, i) => (
          <li
            key={stage}
            className={cn(
              "after:content-['·'] after:pl-1 last:after:content-none",
              i === at && 'font-bold text-foreground',
            )}
          >
            {t(`stage.${stage}`)}
          </li>
        ))}
      </ol>
    </div>
  )
}

type Step = {
  title: string
  when?: string
  body?: string
  state: 'done' | 'cur' | 'warn' | 'stop' | 'next'
}

/** What comes after the history, per status. `cur` marks the step that is happening now. */
const UPCOMING: Record<ProjectStatus, { key: string; state: 'cur' | 'next' }[]> = {
  draft: [
    { key: 'send', state: 'next' },
    { key: 'published', state: 'next' },
  ],
  submitted: [
    { key: 'review', state: 'cur' },
    { key: 'published', state: 'next' },
  ],
  changes_requested: [{ key: 'resubmit', state: 'next' }],
  rejected: [],
  approved: [{ key: 'publish', state: 'cur' }],
  published: [{ key: 'select', state: 'cur' }],
  matched: [{ key: 'work', state: 'cur' }],
  in_progress: [{ key: 'deliver', state: 'cur' }],
  delivered: [{ key: 'accept', state: 'cur' }],
  closed: [],
}

/**
 * The project's history as a timeline ("Final pass" mockup, company project page, History): what
 * happened and when, from the activity log (status and time only), then what comes next.
 */
export async function ProjectTimeline({
  status,
  history,
  accepted = false,
}: {
  status: ProjectStatus
  history: HistoryEntry[]
  /** The released work is accepted: Konnected closes the project next. */
  accepted?: boolean
}) {
  const t = await getTranslations('ProjectStatus')
  const format = await getFormatter()
  const upcoming =
    status === 'delivered' && accepted
      ? [{ key: 'close', state: 'cur' as const }]
      : UPCOMING[status]
  const hasCurrent = upcoming.some((u) => u.state === 'cur')

  const past: Step[] = history.map((entry, i) => {
    const last = i === history.length - 1
    const key = entry.created ? 'created' : entry.status
    let state: Step['state'] = 'done'
    if (last && !hasCurrent) {
      if (status === 'changes_requested') state = 'warn'
      else if (status === 'rejected') state = 'stop'
      else if (status !== 'closed') state = 'cur'
    }
    return {
      title: t.has(`history.${key}`) ? t(`history.${key}`) : t(`pill.${entry.status}`),
      when: format.dateTime(new Date(entry.at), { dateStyle: 'medium', timeZone: 'Europe/Oslo' }),
      body: key === 'created' && status === 'draft' ? t('historyBody.created') : undefined,
      state,
    }
  })
  const next: Step[] = upcoming.map((u) => ({
    title: t(`upcoming.${u.key}.title`),
    when: u.state === 'cur' ? t('now') : undefined,
    body: t(`upcoming.${u.key}.body`),
    state: u.state,
  }))
  const steps = [...past, ...next]
  const current = steps.findIndex((s) => s.state === 'cur' || s.state === 'warn')

  return (
    <ol className="grid">
      {steps.map((step, i) => (
        <li
          key={`${step.title}-${i}`}
          aria-current={i === current ? 'step' : undefined}
          className={cn(
            'relative grid grid-cols-[28px_minmax(0,1fr)] gap-3.5 pb-[18px] last:pb-0',
            // The line down to the next step.
            "before:absolute before:top-8 before:bottom-1 before:left-[13px] before:w-0.5 before:rounded-full before:bg-line before:content-[''] last:before:hidden",
            step.state === 'done' && 'before:bg-data',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'relative grid size-7 place-items-center rounded-full border-[1.5px] bg-surface text-[0.8rem] font-bold [font-variant-numeric:tabular-nums]',
              step.state === 'done' && 'border-success text-success',
              step.state === 'cur' && 'border-primary bg-primary text-primary-foreground',
              step.state === 'warn' && 'border-warning bg-warning text-background',
              step.state === 'stop' && 'border-input text-muted-foreground',
              step.state === 'next' && 'border-input text-muted-foreground',
            )}
          >
            {step.state === 'done' ? (
              <CheckIcon className="size-3.5" strokeWidth={3} />
            ) : step.state === 'stop' ? (
              <XIcon className="size-3.5" strokeWidth={3} />
            ) : (
              i + 1
            )}
          </span>
          <div className="min-w-0">
            <b
              className={cn(
                'block font-semibold',
                step.state === 'next' && 'text-muted-foreground',
              )}
            >
              {step.title}
              {step.state !== 'next' && (
                <span className="sr-only">
                  {' '}
                  ({step.state === 'done' ? t('stepDone') : t('stepCurrent')})
                </span>
              )}
            </b>
            {step.when && (
              <span
                className={cn(
                  'block text-[0.85rem] text-muted-foreground',
                  (step.state === 'cur' || step.state === 'warn') &&
                    'font-semibold text-foreground',
                )}
              >
                {step.when}
              </span>
            )}
            {step.body && (
              <p className="mt-0.5 max-w-[56ch] text-[0.9rem] text-muted-foreground">{step.body}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
