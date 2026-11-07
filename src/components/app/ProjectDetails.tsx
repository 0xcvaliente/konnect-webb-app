import { DownloadIcon, FileTextIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { parseDay, type PayChoice, type WorkMode } from '@/lib/projects/fields'

import type { BriefFileInfo } from './BriefFilesField'

/** A project as the company wrote it, ready to show. Dates are `YYYY-MM-DD`. */
export type ProjectView = {
  description: string | null
  tasks: string | null
  desiredSkills: string[]
  workloadHours: number | null
  durationWeeks: number | null
  startDate: string | null
  deadline: string | null
  workMode: WorkMode | null
  location: string | null
  deliverable: string | null
  paidOrUnpaid: PayChoice | null
  unpaidBenefit: string | null
  /** Only for the company's own view. Students get the files only once Konnected selects them. */
  attachments?: BriefFileInfo[]
}

/**
 * The project's answers as a list ("Final pass" mockup, company project page, What you asked
 * for). Used on the company's project page and in the form's preview, so it works as a server
 * and a client component. Shows nothing about any student, and never the price.
 */
export function ProjectDetails({ project }: { project: ProjectView }) {
  const t = useTranslations('ProjectFields')
  const format = useFormatter()
  const missing = <span className="text-muted-foreground">{t('notFilled')}</span>

  const day = (value: string | null) => {
    const parsed = parseDay(value)
    if (!parsed) return missing
    const [y, m, d] = parsed.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'long',
      timeZone: 'Europe/Oslo',
    })
  }
  const text = (value: string | null) =>
    value?.trim() ? <span className="whitespace-pre-line">{value}</span> : missing

  const where = project.workMode
    ? project.workMode === 'remote'
      ? t('workModeOption.remote')
      : `${t(`workModeOption.${project.workMode}`)}${project.location ? `, ${project.location}` : ''}`
    : null

  const rows: [string, ReactNode][] = [
    [
      t('desiredSkills'),
      project.desiredSkills.length ? (
        <span className="flex flex-wrap gap-1.5">
          {project.desiredSkills.map((skill) => (
            <Badge key={skill} variant="tag">
              {skill}
            </Badge>
          ))}
        </span>
      ) : (
        missing
      ),
    ],
    [
      t('workloadHours'),
      project.workloadHours ? t('hours', { count: project.workloadHours }) : missing,
    ],
    [
      t('durationWeeks'),
      project.durationWeeks ? t('weeks', { count: project.durationWeeks }) : missing,
    ],
    [t('startDate'), day(project.startDate)],
    [t('deadline'), day(project.deadline)],
    [t('workMode'), where ?? missing],
    [t('deliverable'), text(project.deliverable)],
    [
      t('payment'),
      project.paidOrUnpaid ? (
        <span className="grid gap-1">
          <span>{t(`payOption.${project.paidOrUnpaid}`)}</span>
          {project.paidOrUnpaid === 'unpaid' && (
            <span className="text-muted-foreground">
              {t('unpaidBenefitShort')}: {text(project.unpaidBenefit)}
            </span>
          )}
        </span>
      ) : (
        missing
      ),
    ],
  ]

  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <h3 className="text-[0.9rem] font-semibold">{t('description')}</h3>
        <p className="[overflow-wrap:anywhere]">{text(project.description)}</p>
      </div>
      {project.tasks?.trim() && (
        <div className="grid gap-1.5">
          <h3 className="text-[0.9rem] font-semibold">{t('tasks')}</h3>
          <ul className="grid list-disc gap-1 pl-5 [overflow-wrap:anywhere] marker:text-primary">
            {project.tasks
              .split('\n')
              .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
              .filter(Boolean)
              .map((line, i) => (
                <li key={i}>{line}</li>
              ))}
          </ul>
        </div>
      )}
      <dl className="grid gap-x-[18px] gap-y-3 sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere] max-sm:mb-1">{value}</dd>
          </div>
        ))}
      </dl>
      {project.attachments && project.attachments.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-[0.9rem] font-semibold">{t('attachments')}</h3>
          <ul className="grid gap-2">
            {project.attachments.map((file) => (
              <li
                key={file.id}
                className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line px-3.5 py-2.5"
              >
                <FileTextIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 basis-40 font-medium [overflow-wrap:anywhere]">
                  {file.name}
                </span>
                {file.url && (
                  <a
                    href={file.url}
                    download={file.name}
                    className="inline-flex min-h-11 items-center gap-1.5 font-semibold sm:min-h-8"
                  >
                    <DownloadIcon aria-hidden="true" className="size-4" />
                    {t('download')}
                    <span className="sr-only">: {file.name}</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
