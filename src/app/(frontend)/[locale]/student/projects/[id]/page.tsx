import {
  CalendarClockIcon,
  CircleCheckIcon,
  FolderSearchIcon,
  HourglassIcon,
  UserRoundPenIcon,
} from 'lucide-react'
import { hasLocale, useTranslations } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { ApplyForm } from '@/components/app/applications/ApplyForm'
import { Banner } from '@/components/app/Banner'
import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { APPLICATION_STATUS_TONE, decisionDay } from '@/lib/applications/fields'
import { applyBoxFor, type ApplyBox as ApplyBoxState } from '@/lib/applications/student'
import { findProjectForStudent, type ProjectPage } from '@/lib/projects/browse'
import { requireStudent } from '@/lib/students/session'

import { useDay, useKroner, useWhere } from '../ProjectCard'

// A published project for students ("Final pass" mockup, Project and apply): the full brief,
// the company's name and logo, the facts, and the apply box. Never the brief's attachments: only
// the student Konnected selects gets those. Read as the student with access control on: a
// project that is not published is "not open". The apply box shows what the student may do: apply
// with a note, or why not (already applied, withdrawn, 2 running projects, profile changes asked).
export const dynamic = 'force-dynamic'

/** The project's facts in the side card. A plain component, so it can use the formatters. */
function Facts({ project }: { project: ProjectPage }) {
  const t = useTranslations('StudentProjects.detail')
  const ts = useTranslations('StudentProjects')
  const tf = useTranslations('ProjectFields')
  const day = useDay()
  const kroner = useKroner()
  const where = useWhere()(project)
  const notSet = <span className="text-muted-foreground">{t('notSet')}</span>

  let payment: ReactNode = notSet
  if (project.paidOrUnpaid === 'paid') {
    payment = (
      <span className="grid gap-1">
        <span>
          {project.studentPay
            ? ts('paidAmount', { amount: kroner(project.studentPay) })
            : ts('paid')}
        </span>
        <span className="text-[0.85rem] font-normal text-muted-foreground">
          {project.studentPay ? t('paidNote') : t('paidNoAmount')}
        </span>
      </span>
    )
  } else if (project.paidOrUnpaid === 'unpaid') {
    payment = (
      <span className="grid gap-1">
        <span>{ts('unpaid')}</span>
        <span className="text-[0.85rem] font-normal [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
          {project.unpaidBenefit ? `${t('youGet')}: ${project.unpaidBenefit}` : t('unpaidNote')}
        </span>
      </span>
    )
  }

  const rows: [string, ReactNode][] = [
    [t('workload'), project.workloadHours ? tf('hours', { count: project.workloadHours }) : notSet],
    [
      t('timeframe'),
      project.durationWeeks ? tf('weeks', { count: project.durationWeeks }) : notSet,
    ],
    [t('start'), day(project.startDate, 'long') ?? notSet],
    [t('where'), where ?? notSet],
    [t('applyBy'), day(project.deadline, 'long') ?? notSet],
    // Konnected's promise: a decision within 3 working days after applications close.
    ...(project.deadline
      ? ([[t('decideBy'), day(decisionDay(project.deadline), 'long')]] as [string, ReactNode][])
      : []),
    [t('payment'), payment],
  ]
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The apply box under the facts. Every rule here is checked again on the server when applying. */
function ApplyBox({ project, box }: { project: ProjectPage; box: ApplyBoxState | null }) {
  const t = useTranslations('StudentProjects.detail')
  const ta = useTranslations('Apply')
  const ts = useTranslations('ApplicationStatus')

  if (box?.kind === 'applied') {
    return (
      <div className="grid gap-3">
        <Banner tone="ok" icon={CircleCheckIcon}>
          <div className="grid gap-1">
            <p className="flex flex-wrap items-center gap-2 font-semibold">
              {ta('appliedTitle')}
              <Badge tone={APPLICATION_STATUS_TONE[box.status]}>{ts(box.status)}</Badge>
            </p>
            <p className="text-[0.88rem] text-muted-foreground">{ta('appliedBody')}</p>
          </div>
        </Banner>
        <Button asChild variant="secondary" className="w-full">
          <Link href={`/student/applications/${box.applicationId}`}>{ta('seeApplication')}</Link>
        </Button>
      </div>
    )
  }
  if (box?.kind === 'withdrawn') {
    return (
      <div className="grid gap-3">
        <Banner>
          <div className="grid gap-0.5">
            <p className="font-semibold">{ta('withdrawnTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{ta('withdrawnBody')}</p>
          </div>
        </Banner>
        <Button asChild variant="secondary" className="w-full">
          <Link href={`/student/applications/${box.applicationId}`}>{ta('seeApplication')}</Link>
        </Button>
      </div>
    )
  }
  if (!project.open) {
    return (
      <div className="grid gap-3">
        <Banner icon={CalendarClockIcon}>
          <div className="grid gap-0.5">
            <p className="font-semibold">{t('closedTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('closedBody')}</p>
          </div>
        </Banner>
        <Button asChild variant="secondary" className="w-full">
          <Link href="/student/projects">{t('otherProjects')}</Link>
        </Button>
      </div>
    )
  }
  if (box?.kind === 'too_many') {
    return (
      <Banner tone="warn">
        <div className="grid gap-0.5">
          <p className="font-semibold">{ta('tooManyTitle')}</p>
          <p className="text-[0.88rem] text-muted-foreground">{ta('tooManyBody')}</p>
        </div>
      </Banner>
    )
  }
  if (box?.kind === 'changes_requested') {
    return (
      <div className="grid gap-3">
        <Banner tone="warn" icon={UserRoundPenIcon}>
          <div className="grid gap-0.5">
            <p className="font-semibold">{ta('changesTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{ta('changesBody')}</p>
          </div>
        </Banner>
        <Button asChild variant="normal" className="w-full">
          <Link href="/student/profile">{ta('changesAction')}</Link>
        </Button>
      </div>
    )
  }
  if (box?.kind !== 'open') return null
  return (
    <div className="grid gap-3">
      <p className="text-[0.88rem] text-muted-foreground">{t('limit')}</p>
      {box.profileWaiting && (
        <Banner icon={HourglassIcon}>
          <div className="grid gap-0.5">
            <p className="font-semibold">{ta('waitingTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{ta('waitingBody')}</p>
          </div>
        </Banner>
      )}
      <ApplyForm projectId={project.id} />
      {!box.decideBy && (
        <p className="text-[0.85rem] text-muted-foreground">{ta('decideNoDate')}</p>
      )}
    </div>
  )
}

export default async function StudentProjectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const project = /^\d{1,10}$/.test(id)
    ? await findProjectForStudent(payload, user, Number(id))
    : null
  const t = await getTranslations('StudentProjects.detail')
  const ts = await getTranslations('StudentProjects')
  const crumb = { href: '/student/projects', label: t('back') }

  if (!project) {
    return (
      <SiteShell
        role="student"
        current="projects"
        user={account}
        crumb={crumb}
        title={t('notOpenTitle')}
      >
        <Card className="items-center py-10 text-center">
          <FolderSearchIcon aria-hidden="true" className="size-8 text-primary" />
          <p className="max-w-[46ch] text-muted-foreground">{t('notOpenBody')}</p>
          <div className="flex flex-wrap justify-center gap-2.5">
            <Button asChild>
              <Link href="/student/projects">{t('seeProjects')}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/student/profile">{ts('emptyAction')}</Link>
            </Button>
          </div>
        </Card>
      </SiteShell>
    )
  }

  const box = await applyBoxFor(payload, user, project.id, project.deadline)

  const tasks = (project.tasks ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)

  return (
    <SiteShell
      role="student"
      current="projects"
      user={account}
      crumb={crumb}
      title={<span className="[overflow-wrap:anywhere]">{project.title}</span>}
      lede={
        <span className="inline-flex max-w-full items-center gap-2.5 align-middle">
          <CompanyAvatar
            name={project.companyName}
            logoUrl={project.logoUrl}
            // On the band the tint would vanish in dark mode; the surface stands out in both.
            className="bg-surface"
          />
          <span className="font-semibold text-band-foreground">{project.companyName}</span>
        </span>
      }
    >
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] md:gap-[26px]">
        <div className="grid min-w-0 gap-6 md:gap-[26px]">
          <Card className="gap-3">
            <CardTitle className="text-base">{t('whatYouDo')}</CardTitle>
            {project.description && (
              <p className="[overflow-wrap:anywhere] whitespace-pre-line">{project.description}</p>
            )}
            {tasks.length > 0 && (
              <div className="grid gap-1.5 pt-1">
                <h3 className="text-[0.9rem] font-semibold">{t('tasks')}</h3>
                <ul className="grid list-disc gap-1 pl-5 [overflow-wrap:anywhere] marker:text-primary">
                  {tasks.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {project.skills.length > 0 && (
            <Card className="gap-3">
              <CardTitle className="text-base">{t('skills')}</CardTitle>
              <ul className="flex flex-wrap gap-1.5">
                {project.skills.map((skill) => (
                  <li key={skill} className="max-w-full">
                    <Badge variant="tag" className="max-w-full truncate">
                      {skill}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {project.deliverable && (
            <Card className="gap-3">
              <CardTitle className="text-base">{t('deliverable')}</CardTitle>
              <p className="[overflow-wrap:anywhere] whitespace-pre-line">{project.deliverable}</p>
            </Card>
          )}
        </div>

        <aside className="min-w-0" aria-label={t('facts')}>
          <Card className="gap-5">
            <Facts project={project} />

            <ApplyBox project={project} box={box} />
            <p className="text-[0.82rem] text-muted-foreground">{t('filesNote')}</p>
          </Card>
        </aside>
      </div>
    </SiteShell>
  )
}
