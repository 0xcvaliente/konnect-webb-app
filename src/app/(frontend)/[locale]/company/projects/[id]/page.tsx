import config from '@payload-config'
import {
  CalendarClockIcon,
  CircleCheckIcon,
  ClockIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
} from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { Banner } from '@/components/app/Banner'
import { CompanyWork } from '@/components/app/deliverables/CompanyWork'
import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { ProjectDetails } from '@/components/app/ProjectDetails'
import { ProjectTimeline, ProjectTrack } from '@/components/app/ProjectProgress'
import { SelectedStudent } from '@/components/app/SelectedStudent'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { loadCompanyWork } from '@/lib/deliverables/student'
import { PAYMENT_TERMS_DAYS, priceBreakdown, VAT_RATE } from '@/lib/money'
import { requireOwnCompany } from '@/lib/companies/session'
import { isEditable, PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { findOwnProject, findSelectedStudent, projectHistory } from '@/lib/projects/project'
import { projectToView } from '@/lib/projects/view'
import { storedToDay } from '@/lib/projects/fields'

// The company's project page ("Final pass" mockup, company project page): where the project
// stands, the selected student (only what that student agreed to share, from the match's shared
// copy), Konnected's latest note, the history, and what the company asked for. Read as the company
// user with access control on: another company's project is "not found". No applicant is ever
// read here, and nothing about the selected student beyond the shared copy.
export const dynamic = 'force-dynamic'

const BANNER_TONE = {
  draft: 'info',
  submitted: 'info',
  changes_requested: 'warn',
  rejected: 'bad',
  approved: 'ok',
  published: 'ok',
  matched: 'ok',
  in_progress: 'info',
  delivered: 'ok',
  closed: 'ok',
} as const

export default async function CompanyProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>
  searchParams: Promise<{ sent?: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const project = await findOwnProject(payload, user, Number(id), 1)
  if (!project) notFound()
  // A project closed without delivery or without a match has no work to show.
  const working =
    ['in_progress', 'delivered', 'closed'].includes(project.status) &&
    project.closeOutcome !== 'no_delivery' &&
    project.closeOutcome !== 'no_match'
  const [history, student, work, current] = await Promise.all([
    projectHistory(payload, project.id),
    // Only the selected student's shared copy, once Konnected has selected one; never any other
    // applicant (a company cannot read applications at all).
    findSelectedStudent(payload, user, project.id),
    // Only the work Konnected released (the collection returns nothing else to a company).
    working ? loadCompanyWork(payload, user, project.id, project.status) : null,
    // The current match's dates (the company reads only the match that runs now): the due date
    // and the earlier ones Konnected moved it from. Never why.
    payload.find({
      collection: 'matches',
      where: { project: { equals: project.id } },
      limit: 1,
      depth: 0,
      select: { endDate: true, dueDateHistory: true },
      user,
      overrideAccess: false,
    }),
  ])
  const match = current.docs[0]
  const dueDay = storedToDay(match?.endDate)
  const movedFrom = (match?.dueDateHistory ?? [])
    .map((h) => storedToDay(h.from))
    .filter((d): d is string => Boolean(d))
  const { sent } = await searchParams

  const t = await getTranslations('CompanyProject')
  const s = await getTranslations('ProjectStatus')
  const format = await getFormatter()
  const status = project.status
  const logoUrl = typeof company.logo === 'object' ? company.logo?.url : null
  const editable = isEditable(status) && company.status !== 'rejected'
  const justSent = sent === '1' && status === 'submitted'
  const note = project.noteToCompany?.trim()
  // Konnected's fixed price, once set at review (paid projects only). The company reads it.
  const price =
    project.paidOrUnpaid === 'paid' && project.fee && status !== 'draft' && status !== 'submitted'
      ? priceBreakdown(project.fee)
      : null
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  const longDay = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'long',
      timeZone: 'Europe/Oslo',
    })
  }
  // The new plan after a problem path: Konnected finds a new student, reopened applications,
  // closed the project without delivery or without a match, or moved the due date. Never the
  // student's own note.
  const closesDay = storedToDay(project.deadline)
  const plan: {
    key: string
    values: Record<string, string>
    icon?: typeof RotateCcwIcon
    reason: string | null
  } | null =
    status === 'published' && project.reopenedAt && closesDay
      ? {
          key: project.reopenReason === 'match_ended' ? 'reopened_match' : 'reopened',
          values: { date: longDay(closesDay) },
          icon: RotateCcwIcon,
          reason: null,
        }
      : status === 'closed' &&
          project.closedAt &&
          (project.closeOutcome === 'no_delivery' || project.closeOutcome === 'no_match')
        ? {
            key: project.closeOutcome,
            values: {
              date: format.dateTime(new Date(project.closedAt), {
                dateStyle: 'long',
                timeZone: 'Europe/Oslo',
              }),
            },
            icon: undefined,
            reason: project.closeReason ?? null,
          }
        : (status === 'matched' || status === 'in_progress') && dueDay && movedFrom.length
          ? {
              key: 'due_moved',
              values: { date: longDay(dueDay), from: longDay(movedFrom[movedFrom.length - 1]!) },
              icon: CalendarClockIcon,
              reason: null,
            }
          : null
  const noteDate = project.noteToCompanyAt
    ? format.dateTime(new Date(project.noteToCompanyAt), {
        dateStyle: 'medium',
        timeZone: 'Europe/Oslo',
      })
    : null

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="projects"
      crumb={{ href: '/company/projects', label: t('back') }}
      title={<span className="[overflow-wrap:anywhere]">{project.title}</span>}
      lede={
        <span className="inline-flex flex-wrap items-center gap-2.5">
          <CompanyAvatar name={company.name} logoUrl={logoUrl} />
          <b className="font-semibold text-band-foreground">{company.name}</b>
        </span>
      }
      actions={
        <Badge tone={PROJECT_STATUS_TONE[status]} className="bg-surface">
          {s(`pill.${status}`)}
        </Badge>
      }
    >
      <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6 sm:gap-[26px]">
          {justSent ? (
            <Banner tone="ok" icon={CircleCheckIcon} role="status">
              <p className="font-semibold">{t('sentTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('sentBody')}</p>
            </Banner>
          ) : plan ? null : (
            <Banner
              tone={BANNER_TONE[status]}
              icon={status === 'submitted' || status === 'in_progress' ? ClockIcon : undefined}
            >
              <p className="font-semibold">{t(`banner.${status}.title`)}</p>
              <p className="text-[0.88rem] text-muted-foreground">
                {status === 'draft' && company.status !== 'approved'
                  ? t('banner.draft.pending')
                  : status === 'delivered' && work?.state.accepted
                    ? t('banner.deliveredAccepted')
                    : t(`banner.${status}.body`)}
              </p>
            </Banner>
          )}

          {plan && (
            <Banner tone="warn" icon={plan.icon}>
              <p className="font-semibold">{t(`plan.${plan.key}.title`, plan.values)}</p>
              <p className="text-[0.88rem] text-muted-foreground">
                {t(`plan.${plan.key}.body`, plan.values)}
              </p>
              {plan.reason && (
                <p className="mt-1 text-[0.88rem] [overflow-wrap:anywhere] whitespace-pre-line">
                  {plan.reason}
                </p>
              )}
            </Banner>
          )}

          {work && <CompanyWork work={work} />}
          {student && <SelectedStudent student={student} />}

          {status !== 'draft' && (
            <Card>
              <CardHeader className="flex flex-wrap items-baseline justify-between gap-x-4">
                <CardTitle>{t('latestTitle')}</CardTitle>
                {note && noteDate && (
                  <span className="text-[0.85rem] text-muted-foreground">{noteDate}</span>
                )}
              </CardHeader>
              {note ? (
                <p className="[overflow-wrap:anywhere] whitespace-pre-line">{note}</p>
              ) : (
                <p className="inline-flex items-start gap-2 text-muted-foreground">
                  <MessageSquareTextIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {t('latestEmpty')}
                </p>
              )}
              {note && <p className="text-[0.85rem] text-muted-foreground">{t('latestFrom')}</p>}
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t('historyTitle')}</CardTitle>
            </CardHeader>
            <ProjectTimeline
              status={status}
              history={history}
              accepted={Boolean(work?.state.accepted)}
            />
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('askedTitle')}</CardTitle>
            </CardHeader>
            <ProjectDetails project={projectToView(project)} />
          </Card>
        </div>

        <aside className="grid gap-6 sm:gap-[26px] md:sticky md:top-24">
          <Card>
            <CardHeader>
              <CardTitle>{t('progressTitle')}</CardTitle>
            </CardHeader>
            <ProjectTrack status={status} />
          </Card>
          {dueDay &&
            (status === 'matched' || status === 'in_progress' || status === 'delivered') && (
              <Card className="gap-2">
                <CardHeader>
                  <CardTitle>{t('dueTitle')}</CardTitle>
                </CardHeader>
                <p className="font-medium">{t('dueValue', { date: longDay(dueDay) })}</p>
                {movedFrom.length > 0 && (
                  <p className="text-[0.85rem] text-muted-foreground">
                    {t('dueWas', { date: longDay(movedFrom[movedFrom.length - 1]!) })}
                  </p>
                )}
              </Card>
            )}
          {price && (
            <Card>
              <CardHeader>
                <CardTitle>{t('priceTitle')}</CardTitle>
              </CardHeader>
              <dl className="grid grid-cols-[minmax(0,1fr)_max-content] gap-x-4 gap-y-1.5">
                <dt className="text-muted-foreground">{t('priceExVat')}</dt>
                <dd className="text-right tabular-nums">{money(price.price)}</dd>
                <dt className="text-muted-foreground">{t('vat', { rate: VAT_RATE * 100 })}</dt>
                <dd className="text-right tabular-nums">{money(price.vat)}</dd>
                <dt className="border-t border-line pt-1.5 font-semibold">{t('total')}</dt>
                <dd className="border-t border-line pt-1.5 text-right font-semibold tabular-nums">
                  {money(price.total)}
                </dd>
              </dl>
              <p className="text-[0.85rem] text-muted-foreground">
                {t('priceNote', { days: PAYMENT_TERMS_DAYS })}
              </p>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{t('actionsTitle')}</CardTitle>
            </CardHeader>
            {editable ? (
              <Button asChild>
                <Link href={`/company/projects/${project.id}/edit`}>
                  {status === 'draft' ? t('finish') : t('resubmit')}
                </Link>
              </Button>
            ) : status === 'rejected' && company.status !== 'rejected' ? (
              <Button asChild>
                <Link href="/company/projects/new">{t('newProject')}</Link>
              </Button>
            ) : (
              <p className="text-[0.88rem] text-muted-foreground">{t('nothing')}</p>
            )}
            {status === 'draft' && company.status === 'pending' && (
              <p className="text-[0.85rem] text-muted-foreground">{t('pendingHint')}</p>
            )}
          </Card>
        </aside>
      </div>
    </SiteShell>
  )
}
