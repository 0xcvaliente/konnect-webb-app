import {
  CalendarClockIcon,
  CalendarRangeIcon,
  ClockIcon,
  CoinsIcon,
  MapPinIcon,
} from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ComponentType, ReactNode, SVGProps } from 'react'

import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { ProjectCard as ProjectCardData } from '@/lib/projects/browse'
import { parseDay } from '@/lib/projects/fields'

/** A day (`YYYY-MM-DD`) as "14 Nov 2026", in Oslo. */
export function useDay() {
  const format = useFormatter()
  return (value: string | null, style: 'medium' | 'long' = 'medium') => {
    const parsed = parseDay(value)
    if (!parsed) return null
    const [y, m, d] = parsed.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: style,
      timeZone: 'Europe/Oslo',
    })
  }
}

/** Whole kroner as "NOK 4,500" (EN) or "kr 4 500" (NO). */
export function useKroner() {
  const format = useFormatter()
  return (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
}

/** The place in words: "Remote", "On site, Oslo". */
export function useWhere() {
  const t = useTranslations('ProjectFields')
  return (project: Pick<ProjectCardData, 'workMode' | 'location'>) =>
    project.workMode
      ? project.workMode === 'remote'
        ? t('workModeOption.remote')
        : `${t(`workModeOption.${project.workMode}`)}${project.location ? `, ${project.location}` : ''}`
      : null
}

function Fact({
  icon: Icon,
  children,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  children: ReactNode
}) {
  return (
    <li className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <span className="[overflow-wrap:anywhere]">{children}</span>
    </li>
  )
}

/**
 * One open project on the student list ("Final pass" mockup, project card): the company's name
 * and logo, the title, a short description, the facts (workload, timeframe, where, apply by,
 * payment) and the skills. The whole card opens the project. Nothing about any student.
 */
export function ProjectCard({ project }: { project: ProjectCardData }) {
  const t = useTranslations('StudentProjects')
  const tf = useTranslations('ProjectFields')
  const day = useDay()
  const kroner = useKroner()
  const where = useWhere()(project)
  const deadline = day(project.deadline)

  const pay =
    project.paidOrUnpaid === 'paid'
      ? project.studentPay
        ? t('paidAmount', { amount: kroner(project.studentPay) })
        : t('paid')
      : project.paidOrUnpaid === 'unpaid'
        ? t('unpaid')
        : null

  return (
    <Card className="relative h-full gap-3.5 transition-colors has-[a:hover]:border-[color-mix(in_srgb,var(--line)_50%,var(--primary))]">
      <div className="flex min-w-0 items-center gap-3">
        <CompanyAvatar name={project.companyName} logoUrl={project.logoUrl} />
        <div className="grid min-w-0 gap-0.5">
          <h2 className="text-base leading-tight font-semibold [overflow-wrap:anywhere]">
            <Link
              href={`/student/projects/${project.id}`}
              prefetch={false}
              className="text-foreground no-underline after:absolute after:inset-0 after:rounded-card hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:after:ring-3 focus-visible:after:ring-primary focus-visible:after:ring-offset-2"
            >
              {project.title}
            </Link>
          </h2>
          <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
            {project.companyName}
          </p>
        </div>
      </div>

      {project.description && (
        <p className="line-clamp-3 [overflow-wrap:anywhere]">{project.description}</p>
      )}

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[0.88rem] text-muted-foreground">
        {project.workloadHours && (
          <Fact icon={ClockIcon}>{tf('hours', { count: project.workloadHours })}</Fact>
        )}
        {project.durationWeeks && (
          <Fact icon={CalendarRangeIcon}>{tf('weeks', { count: project.durationWeeks })}</Fact>
        )}
        {where && <Fact icon={MapPinIcon}>{where}</Fact>}
        {deadline && <Fact icon={CalendarClockIcon}>{t('applyBy', { date: deadline })}</Fact>}
        {pay && <Fact icon={CoinsIcon}>{pay}</Fact>}
      </ul>

      {project.paidOrUnpaid === 'unpaid' && project.unpaidBenefit && (
        <p className="line-clamp-2 text-[0.88rem] [overflow-wrap:anywhere] text-muted-foreground">
          {t('youGet', { benefit: project.unpaidBenefit })}
        </p>
      )}

      {project.skills.length > 0 && (
        <ul className="mt-auto flex flex-wrap gap-1.5" aria-label={t('skills')}>
          {project.skills.map((skill) => (
            <li key={skill} className="max-w-full">
              <Badge variant="tag" className="max-w-full truncate">
                {skill}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
