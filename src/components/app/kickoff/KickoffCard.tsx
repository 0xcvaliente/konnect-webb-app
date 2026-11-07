import { DownloadIcon, FileIcon, LockIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { KickoffView, StudentAgreementStage } from '@/lib/kickoff/fields'
import type { FileLink } from '@/lib/kickoff/views'
import { osloDay } from '@/lib/workingDays'

/*
 * The kick-off cards ("Final pass" mockup, sets 5 and 6): what Konnected agreed with the student and
 * the company at kick-off. The student's card says where their agreement stands and lists the
 * company's brief files; the company's card says the student sees the same plan. Only what the
 * team wrote at kick-off is shown: nothing from the student's profile.
 */

/** A day (`YYYY-MM-DD`) in words, in Oslo. */
export function useKickoffDay() {
  const format = useFormatter()
  return (day: string, style: 'medium' | 'long' = 'medium') => {
    const [y, m, d] = day.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: style,
      timeZone: 'Europe/Oslo',
    })
  }
}

/** The kick-off as a list of facts (scope, dates, check-ins, contact, how to deliver). */
export function KickoffFacts({
  kickoff,
  team = false,
}: {
  kickoff: KickoffView
  /** The team's own view: "Konnected contact" instead of "Your contact". */
  team?: boolean
}) {
  const t = useTranslations('Kickoff')
  const format = useFormatter()
  const day = useKickoffDay()
  const rows: [string, ReactNode][] = [
    [
      t('scope'),
      <span key="scope" className="whitespace-pre-line">
        {kickoff.scope}
      </span>,
    ],
  ]
  if (kickoff.startDay) rows.push([t('start'), day(kickoff.startDay)])
  if (kickoff.dueDay) rows.push([t('due'), day(kickoff.dueDay)])
  rows.push([
    t('checkIns'),
    kickoff.checkIns.length
      ? format.list(
          kickoff.checkIns.map((d) => day(d)),
          { type: 'conjunction' },
        )
      : t('noCheckIns'),
  ])
  if (kickoff.contactName)
    rows.push([
      team ? t('contact') : t('yourContact'),
      team ? kickoff.contactName : t('contactValue', { name: kickoff.contactName }),
    ])
  rows.push([
    t('delivery'),
    <span key="delivery" className="whitespace-pre-line">
      {kickoff.delivery}
    </span>,
  ])
  return (
    <dl className="grid grid-cols-1 gap-x-[18px] gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground max-sm:mt-1.5 max-sm:text-[0.85rem]">{label}</dt>
          <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const STAGE_TONE: Record<StudentAgreementStage, 'ok' | 'warn' | 'info' | 'mute' | 'bad'> = {
  none: 'mute',
  generating: 'mute',
  awaiting_party: 'warn',
  awaiting_konnected: 'info',
  signed: 'ok',
  failed: 'mute',
}

/** The selected student's kick-off card on their application page. */
export function StudentKickoffCard({
  kickoff,
  company,
  agreement,
  files,
  started,
}: {
  kickoff: KickoffView | null
  company: string
  agreement: { stage: StudentAgreementStage; id: number | null }
  files: FileLink[]
  /** The work has started (the project is past `matched`). */
  started: boolean
}) {
  const t = useTranslations('Kickoff')
  const day = useKickoffDay()
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('title')}</CardTitle>
        {kickoff && !started && (
          <Badge tone={STAGE_TONE[agreement.stage]}>{t(`stage.${agreement.stage}`)}</Badge>
        )}
      </div>
      {kickoff ? (
        <>
          <p className="text-[0.9rem] text-muted-foreground">
            {t('studentIntro', { company, date: day(osloDay(new Date(kickoff.recordedAt))) })}
          </p>
          <KickoffFacts kickoff={kickoff} />
          {!started && agreement.stage === 'awaiting_party' && agreement.id && (
            <div>
              <Button asChild>
                <Link href={`/student/agreements/${agreement.id}`}>{t('sign')}</Link>
              </Button>
            </div>
          )}
          {!started && (
            <p className="text-[0.85rem] text-muted-foreground">{t('studentStartHint')}</p>
          )}
        </>
      ) : (
        <p className="text-[0.9rem] text-muted-foreground">{t('studentWaiting', { company })}</p>
      )}
      <div className="grid gap-2">
        <h3 className="text-[0.95rem] font-semibold">{t('filesTitle', { company })}</h3>
        {files.length ? (
          <ul className="grid gap-2">
            {files.map((f) => (
              <li key={f.id}>
                <a
                  href={f.url}
                  download
                  className="flex min-h-11 items-center gap-3 rounded-item border-[1.5px] border-line px-3.5 py-2.5 text-foreground no-underline hover:bg-surface-2"
                >
                  <FileIcon aria-hidden="true" className="size-5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    {f.name}
                  </span>
                  <DownloadIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                  <span className="sr-only">{t('download')}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-start gap-2 text-[0.9rem] text-muted-foreground">
            <LockIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('noFiles', { company })}
          </p>
        )}
      </div>
    </Card>
  )
}

/** The company's kick-off card on its project page. */
export function CompanyKickoffCard({
  kickoff,
  status,
}: {
  kickoff: KickoffView | null
  status: 'matched' | 'in_progress' | 'delivered'
}) {
  const t = useTranslations('Kickoff')
  return (
    <Card className="gap-4">
      <CardTitle>{t('title')}</CardTitle>
      {kickoff ? (
        <>
          <KickoffFacts kickoff={kickoff} />
          <p className="text-[0.85rem] text-muted-foreground">
            {status === 'matched' ? t('companyMatched') : t('companyRunning')} {t('companySame')}
          </p>
        </>
      ) : (
        <p className="text-[0.9rem] text-muted-foreground">{t('companyWaiting')}</p>
      )}
    </Card>
  )
}
