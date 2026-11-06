import { CheckIcon } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import type { CompanyStatusKey } from '@/lib/companies/fields'
import { cn } from '@/lib/utils'

type Step = { state: 'done' | 'current' | 'todo'; title: string; body: string }

/**
 * Where a company stands ("Final pass" mockup, Company profile, Status): pending review, then
 * approved, then active. The current step is filled, done steps carry a check. `row` lays the
 * steps side by side from 640 px (status page); otherwise they stack (profile aside).
 */
export async function CompanySteps({
  status,
  approvedOn,
  row = false,
}: {
  status: CompanyStatusKey
  /** The approval date, already formatted. */
  approvedOn?: string
  row?: boolean
}) {
  const t = await getTranslations('CompanySteps')
  const steps: Step[] =
    status === 'rejected'
      ? [
          { state: 'done', title: t('review'), body: t('reviewDone') },
          { state: 'current', title: t('rejected'), body: t('rejectedBody') },
        ]
      : [
          {
            state: status === 'pending' ? 'current' : 'done',
            title: t('review'),
            body: status === 'pending' ? t('reviewCurrent') : t('reviewDone'),
          },
          {
            state: status === 'approved' ? 'current' : 'todo',
            title: t('approved'),
            body: approvedOn ?? t('approvedBody'),
          },
          { state: 'todo', title: t('active'), body: t('activeBody') },
        ]

  return (
    <ol aria-label={t('label')} className={cn('grid gap-1', row && 'sm:grid-cols-3 sm:gap-4')}>
      {steps.map((step, i) => (
        <li
          key={step.title}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-[7px]"
        >
          <span
            aria-hidden="true"
            className={cn(
              'grid size-7 place-items-center rounded-full border-[1.5px] text-[0.8rem] font-bold [font-variant-numeric:tabular-nums]',
              step.state === 'done' && 'border-success text-success',
              step.state === 'current' && 'border-primary bg-primary text-primary-foreground',
              step.state === 'todo' && 'border-input bg-surface text-muted-foreground',
            )}
          >
            {step.state === 'done' ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
          </span>
          <span className="grid min-w-0 gap-0.5">
            <b className="font-semibold">
              {step.title}
              {step.state !== 'todo' && (
                <span className="sr-only">
                  {' '}
                  ({step.state === 'done' ? t('done') : t('current')})
                </span>
              )}
            </b>
            <small className="text-[0.85rem] text-muted-foreground">{step.body}</small>
          </span>
        </li>
      ))}
    </ol>
  )
}
