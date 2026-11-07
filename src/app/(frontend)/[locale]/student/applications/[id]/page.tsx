import { CheckIcon, ClockIcon, FileSearchIcon, LockIcon, XIcon } from 'lucide-react'
import { hasLocale, useFormatter, useTranslations } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { WithdrawForm } from '@/components/app/applications/WithdrawForm'
import { Banner } from '@/components/app/Banner'
import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { APPLICATION_STATUS_TONE, canWithdraw } from '@/lib/applications/fields'
import { findOwnApplication, type OwnApplication } from '@/lib/applications/student'
import { requireStudent } from '@/lib/students/session'
import { cn } from '@/lib/utils'

import { useDay } from '../../projects/ProjectCard'

// One application ("Final pass" mockup, the student's application page): the decision promise,
// the progress from applied to the decision, the student's note, the project, what the company
// sees (nothing until Konnected selects the student), and withdrawing while Konnected decides.
// Read as the student with access control on: another student's application is "not found".
export const dynamic = 'force-dynamic'

type StepState = 'done' | 'cur' | 'stop' | 'next'
type StepKey =
  | 'applied'
  | 'assess'
  | 'shortlisted'
  | 'decide'
  | 'result'
  | 'work'
  | 'selected'
  | 'notSelected'
  | 'withdrawn'
type Step = { key: string; title: string; when?: string | null; body?: string; state: StepState }

/** The steps for the application's status, oldest first. */
function useSteps(a: OwnApplication): Step[] {
  const t = useTranslations('Application')
  const format = useFormatter()
  const day = useDay()
  const at = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' }) : null
  const step = (key: StepKey, state: StepState, when?: string | null, company?: string): Step => ({
    key,
    title: t(`step.${key}.title`),
    body:
      key === 'selected'
        ? t('step.selected.body', { company: company ?? '' })
        : t(`step.${key}.body` as `step.applied.body`),
    when,
    state,
  })
  const closes = day(a.closingDay)
  const decideBy = day(a.decideBy)
  const steps: Step[] = [step('applied', 'done', at(a.appliedAt))]
  const wasShortlisted = Boolean(a.shortlistedAt)

  switch (a.status) {
    case 'applied':
      steps.push(
        step('assess', 'cur', closes ? t('closes', { date: closes }) : t('now')),
        step('result', 'next'),
        step('work', 'next'),
      )
      break
    case 'shortlisted':
      steps.push(
        step('shortlisted', 'done', at(a.shortlistedAt)),
        step('decide', 'cur', decideBy ? t('by', { date: decideBy }) : t('now')),
        step('work', 'next'),
      )
      break
    case 'selected':
      if (wasShortlisted) steps.push(step('shortlisted', 'done', at(a.shortlistedAt)))
      steps.push(step('selected', 'cur', at(a.decidedAt), a.companyName), step('work', 'next'))
      break
    case 'not_selected':
      if (wasShortlisted) steps.push(step('shortlisted', 'done', at(a.shortlistedAt)))
      steps.push(step('notSelected', 'stop', at(a.decidedAt)))
      break
    case 'withdrawn':
      if (wasShortlisted) steps.push(step('shortlisted', 'done', at(a.shortlistedAt)))
      steps.push(step('withdrawn', 'stop', at(a.withdrawnAt)))
      break
  }
  return steps
}

/** The progress track and the steps as a timeline (like the company's project history). */
function Progress({ application }: { application: OwnApplication }) {
  const t = useTranslations('Application')
  const steps = useSteps(application)
  const current = steps.findIndex((s) => s.state === 'cur')
  const label =
    current < 0
      ? t('finished')
      : t('stepOf', { n: current + 1, total: steps.length }) + `: ${steps[current]!.title}`
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>{t('progress')}</CardTitle>
        <span className="text-[0.85rem] text-muted-foreground">
          {current < 0 ? t('finished') : t('stepOf', { n: current + 1, total: steps.length })}
        </span>
      </div>
      <div
        role="img"
        aria-label={label}
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      >
        {steps.map((s) => (
          <i
            key={s.key}
            className={cn(
              'block h-2 rounded-full bg-surface-2',
              (s.state === 'done' || s.state === 'stop') &&
                'bg-[color-mix(in_srgb,var(--data)_38%,var(--surface))]',
              s.state === 'cur' && 'bg-data',
            )}
          />
        ))}
      </div>
      <ol className="grid">
        {steps.map((s, i) => (
          <li
            key={s.key}
            aria-current={i === current ? 'step' : undefined}
            className={cn(
              'relative grid grid-cols-[28px_minmax(0,1fr)] gap-3.5 pb-[18px] last:pb-0',
              "before:absolute before:top-8 before:bottom-1 before:left-[13px] before:w-0.5 before:rounded-full before:bg-line before:content-[''] last:before:hidden",
              s.state === 'done' && 'before:bg-data',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'relative grid size-7 place-items-center rounded-full border-[1.5px] bg-surface text-[0.8rem] font-bold [font-variant-numeric:tabular-nums]',
                s.state === 'done' && 'border-success text-success',
                s.state === 'cur' && 'border-primary bg-primary text-primary-foreground',
                (s.state === 'stop' || s.state === 'next') && 'border-input text-muted-foreground',
              )}
            >
              {s.state === 'done' ? (
                <CheckIcon className="size-3.5" strokeWidth={3} />
              ) : s.state === 'stop' ? (
                <XIcon className="size-3.5" strokeWidth={3} />
              ) : (
                i + 1
              )}
            </span>
            <div className="min-w-0">
              <b
                className={cn('block font-semibold', s.state === 'next' && 'text-muted-foreground')}
              >
                {s.title}
                {s.state !== 'next' && (
                  <span className="sr-only">
                    {' '}
                    ({s.state === 'cur' ? t('stepCurrent') : t('stepDone')})
                  </span>
                )}
              </b>
              {s.when && (
                <span
                  className={cn(
                    'block text-[0.85rem] text-muted-foreground',
                    s.state === 'cur' && 'font-semibold text-foreground',
                  )}
                >
                  {s.when}
                </span>
              )}
              {s.body && (
                <p className="mt-0.5 max-w-[56ch] text-[0.9rem] text-muted-foreground">{s.body}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

/** The project's facts in the side card, while it is still listed. */
function ProjectFacts({ application: a }: { application: OwnApplication }) {
  const t = useTranslations('Application')
  const tf = useTranslations('ProjectFields')
  const day = useDay()
  const rows: [string, ReactNode][] = [[t('company'), a.companyName]]
  const listed = a.listed
  if (listed?.workloadHours)
    rows.push([t('workload'), tf('hours', { count: listed.workloadHours })])
  if (listed?.durationWeeks)
    rows.push([t('timeframe'), tf('weeks', { count: listed.durationWeeks })])
  if (a.closingDay) rows.push([t('applyBy'), day(a.closingDay, 'long')])
  if (listed?.paidOrUnpaid)
    rows.push([t('payment'), listed.paidOrUnpaid === 'paid' ? t('paid') : t('unpaid')])
  return (
    <Card className="gap-4">
      <CardTitle>{t('projectTitle')}</CardTitle>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {listed?.deliverable && (
        <div className="grid gap-1">
          <h3 className="text-[0.9rem] font-semibold">{t('deliverable')}</h3>
          <p className="text-[0.88rem] [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
            {listed.deliverable}
          </p>
        </div>
      )}
      {listed && a.projectId ? (
        <Button asChild variant="secondary" className="w-full">
          <Link href={`/student/projects/${a.projectId}`}>{t('seeProject')}</Link>
        </Button>
      ) : (
        <p className="text-[0.85rem] text-muted-foreground">{t('notListed')}</p>
      )}
    </Card>
  )
}

export default async function StudentApplicationPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const application = /^\d{1,10}$/.test(id)
    ? await findOwnApplication(payload, user, Number(id))
    : null
  const t = await getTranslations('Application')
  const ts = await getTranslations('ApplicationStatus')
  const crumb = { href: '/student/applications', label: t('back') }

  if (!application) {
    return (
      <SiteShell
        role="student"
        current="applications"
        user={account}
        crumb={crumb}
        title={t('notFoundTitle')}
      >
        <Card className="items-center py-10 text-center">
          <FileSearchIcon aria-hidden="true" className="size-8 text-primary" />
          <p className="max-w-[46ch] text-muted-foreground">{t('notFoundBody')}</p>
          <Button asChild>
            <Link href="/student/applications">{t('seeAll')}</Link>
          </Button>
        </Card>
      </SiteShell>
    )
  }

  const a = application
  const deciding = a.status === 'applied' || a.status === 'shortlisted'
  const formatter = await getFormatter()
  /** A day (`YYYY-MM-DD`) in words, in Oslo. */
  const format = (day: string) => {
    const [y, m, d] = day.split('-').map(Number)
    return formatter.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'long',
      timeZone: 'Europe/Oslo',
    })
  }

  return (
    <SiteShell
      role="student"
      current="applications"
      user={account}
      crumb={crumb}
      title={<span className="[overflow-wrap:anywhere]">{a.title}</span>}
      lede={
        <span className="inline-flex max-w-full flex-wrap items-center gap-2.5 align-middle">
          <CompanyAvatar name={a.companyName} logoUrl={a.listed?.logoUrl} className="bg-surface" />
          <span className="font-semibold text-band-foreground">{a.companyName}</span>
          <Badge tone={APPLICATION_STATUS_TONE[a.status]}>{ts(a.status)}</Badge>
        </span>
      }
    >
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] md:gap-[26px]">
        <div className="grid min-w-0 gap-6 md:gap-[26px]">
          {deciding && (
            <Card className="gap-0 p-0 sm:p-0">
              <Banner icon={ClockIcon} className="rounded-card px-[22px] py-[18px] sm:px-[26px]">
                <div className="grid gap-0.5">
                  <p className="font-semibold">
                    {a.decideBy
                      ? t('decideTitle', { date: format(a.decideBy) })
                      : t('decideNoDateTitle')}
                  </p>
                  <p className="text-[0.88rem] text-muted-foreground">{t('decideBody')}</p>
                </div>
              </Banner>
            </Card>
          )}
          <Progress application={a} />
          {a.note && (
            <Card className="gap-2">
              <CardTitle>{t('noteTitle')}</CardTitle>
              <p className="[overflow-wrap:anywhere] whitespace-pre-line">{a.note}</p>
              <p className="text-[0.82rem] text-muted-foreground">{t('noteHint')}</p>
            </Card>
          )}
        </div>

        <aside className="grid min-w-0 gap-6 md:gap-[26px]" aria-label={t('projectTitle')}>
          <ProjectFacts application={a} />
          <Card className="gap-3">
            <CardTitle>{t('seesTitle', { company: a.companyName })}</CardTitle>
            {a.status === 'selected' ? (
              <>
                <p className="text-[0.9rem] text-muted-foreground">{t('seesSelected')}</p>
                <Button asChild variant="secondary" className="w-full">
                  <Link href="/student/profile">{t('seesSelectedAction')}</Link>
                </Button>
              </>
            ) : (
              <p className="flex items-start gap-2 text-[0.9rem] text-muted-foreground">
                <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>
                  {deciding
                    ? t('seesOpen', { company: a.companyName })
                    : t('seesNone', { company: a.companyName })}
                </span>
              </p>
            )}
          </Card>
          {canWithdraw(a.status) && (
            <Card className="gap-3">
              <div className="grid gap-1">
                <CardTitle>{t('withdrawTitle')}</CardTitle>
                <p className="text-[0.9rem] text-muted-foreground">{t('withdrawBody')}</p>
              </div>
              <WithdrawForm applicationId={a.id} />
            </Card>
          )}
        </aside>
      </div>
    </SiteShell>
  )
}
