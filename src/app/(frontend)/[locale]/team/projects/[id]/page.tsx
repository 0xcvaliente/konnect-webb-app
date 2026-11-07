import {
  CircleCheckIcon,
  CircleIcon,
  ClockIcon,
  FileSearchIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { ActivityCard } from '@/app/(frontend)/[locale]/team/approvals/QueueParts'
import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { priceBreakdown } from '@/lib/money'
import { PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { addDays } from '@/lib/workingDays'
import { todayInOslo } from '@/lib/projects/fields'
import { activityOf, type ActivityRow } from '@/lib/team/approvals'
import { teamCounts } from '@/lib/team/counts'
import { loadTeamProject } from '@/lib/team/projects'
import { listTeam } from '@/lib/team/members'
import { OwnerChip } from '@/app/(frontend)/[locale]/team/approvals/QueueParts'
import { ReassignForm } from '@/components/app/team/TeamForms'
import { requireTeam } from '@/lib/team/session'

import { KickoffFacts } from '@/components/app/kickoff/KickoffCard'
import { loadTeamKickoff, noteHistory } from '@/lib/kickoff/team'

import { KickoffForm, NoteForm, StartWorkButton } from './KickoffForms'
import { PayForm } from './PayForm'
import { ProblemPaths } from './ProblemPaths'

// The team's project page ("Final pass" mockup, team project page, states "Problem reported" and
// "No student selected"): where the project stands, the student's report with the three ways on
// (move the due date, match again, close without delivery), or the choices for a project nobody
// was selected for (reopen, ask the company for changes, close). Read as the team member with
// access control on; the Server Actions and the collection hooks check everything again.
export const dynamic = 'force-dynamic'

type Row = ActivityRow & { source: 'project' | 'match' }

export default async function TeamProjectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const t = await getTranslations('TeamProject')
  const to = await getTranslations('TeamOwner')
  const ts = await getTranslations('ProjectStatus')
  const tRole = await getTranslations('Roles')
  const format = await getFormatter()
  const counts = await teamCounts(payload, user)
  const project = /^\d{1,10}$/.test(id) ? await loadTeamProject(payload, user, Number(id)) : null
  const crumb = { href: '/team', label: t('back') }
  const account = accountMenuUser(user, tRole('admin'))

  if (!project) {
    return (
      <TeamShell
        current="today"
        counts={counts}
        user={account}
        crumb={crumb}
        title={t('notFoundTitle')}
      >
        <Card className="max-w-[880px] items-center py-10 text-center">
          <FileSearchIcon aria-hidden="true" className="size-8 text-primary" />
          <p className="text-muted-foreground">{t('notFoundBody')}</p>
        </Card>
      </TeamShell>
    )
  }

  const day = (value: string | null) => {
    if (!value) return t('notSet')
    const [y, m, d] = value.slice(0, 10).split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      dateStyle: 'medium',
      timeZone: 'Europe/Oslo',
    })
  }
  const at = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' })
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  /** A stored amount from the activity log ("12500"), formatted. */
  const amount = (value: string | null | undefined) =>
    value && /^\d+$/.test(value) ? money(Number(value)) : (value ?? '')
  const today = todayInOslo()
  const team = (await listTeam(payload, user)) ?? []
  const ownerOf = (id: number | null) => {
    const member = id ? team.find((m) => m.id === id) : undefined
    return member ? { id: member.id, name: member.name } : null
  }
  const match = project.match
  const report = project.openReport
  const tk = await getTranslations('Kickoff')
  const tn = await getTranslations('TeamNote')
  // The kick-off of the running match (matched, in progress or delivered), and every note
  // Konnected wrote to the company (the project shows the company only the latest).
  const [kick, notes] = await Promise.all([
    match && ['matched', 'in_progress', 'delivered'].includes(project.status)
      ? loadTeamKickoff(payload, user, project)
      : null,
    noteHistory(payload, user, project.id),
  ])
  const running =
    Boolean(match) && (project.status === 'matched' || project.status === 'in_progress')
  const student = match?.studentName || report?.studentName || ''

  // The activity of the project and of its matches (the due date moves and the match's end).
  const [matchRows] = await Promise.all([
    Promise.all(
      [match, ...project.endedMatches]
        .filter(Boolean)
        .map((m) => activityOf(payload, user, 'matches', m!.id)),
    ),
  ])
  const rows: Row[] = [
    // The notes to the company have their own history card below.
    ...project.activity
      .filter((r) => r.field !== 'noteToCompany')
      .map((r) => ({ ...r, source: 'project' as const })),
    ...matchRows.flat().map((r) => ({ ...r, source: 'match' as const })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const pill = (status: string | null | undefined) =>
    status && ts.has(`pill.${status}`) ? ts(`pill.${status}` as 'pill.draft') : (status ?? '')
  const describe = (row: ActivityRow) => {
    const r = row as Row
    if (r.source === 'match') {
      if (r.field === 'endedAt') return t('activity.ended')
      if (r.field === 'endDate')
        return r.fromStatus
          ? t('activity.dueMoved', { from: day(r.fromStatus), to: day(r.toStatus ?? null) })
          : t('activity.dueSet', { date: day(r.toStatus ?? null) })
      if (r.action === 'create') return pill('matched')
      if (r.field === 'kickoff')
        return r.fromStatus ? t('activity.kickoffChanged') : t('activity.kickoffRecorded')
      return t('activity.other')
    }
    if (r.action === 'create') return t('activity.created')
    if (r.action === 'status_change')
      return t('activity.status', { from: pill(r.fromStatus), to: pill(r.toStatus) })
    if (r.field === 'deadline') return t('activity.deadline', { date: day(r.toStatus ?? null) })
    if (r.action === 'review_change' && (r.field === 'fee' || r.field === 'studentPay')) {
      const key = r.field === 'fee' ? 'price' : 'studentPay'
      if (!r.toStatus) return t(`activity.${key}Cleared`)
      if (!r.fromStatus) return t(`activity.${key}Set`, { to: amount(r.toStatus) })
      return t(`activity.${key}`, { from: amount(r.fromStatus), to: amount(r.toStatus) })
    }
    if (r.action === 'review_change' && r.field === 'applicationsBack')
      return t('activity.applicationsBack', { count: Number(r.toStatus) || 0 })
    if (r.action === 'reassign') {
      if (r.field === 'takenBy') return t('activity.taken', { name: r.toName ?? '?' })
      return r.toName
        ? t('activity.reassigned', { from: r.fromName ?? t('activity.nobody'), to: r.toName })
        : t('activity.unassigned')
    }
    return t('activity.other')
  }

  const facts: [string, ReactNode][] = [
    [t('company'), project.companyName],
    [t('closes'), day(project.closesOn)],
    [t('student'), match ? match.studentName : t('noStudent')],
  ]
  if (match) {
    facts.push([t('start'), day(match.startDay)], [t('due'), day(match.dueDay)])
  }
  facts.push([
    t('applications'),
    t('applicationsValue', { total: project.applications.total, open: project.applications.open }),
  ])

  return (
    <TeamShell
      current="today"
      counts={counts}
      user={account}
      crumb={crumb}
      title={<span className="[overflow-wrap:anywhere]">{project.title}</span>}
      meta={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={PROJECT_STATUS_TONE[project.status]}>{pill(project.status)}</Badge>
          <span className="text-muted-foreground">{project.companyName}</span>
        </span>
      }
    >
      <div className="grid max-w-[1100px] items-start gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6">
          {project.status === 'closed' && project.closedAt && (
            <Card className="gap-3">
              <CardTitle>{t('closedTitle')}</CardTitle>
              <p>
                {t(`outcome.${project.closeOutcome ?? 'delivered'}`, {
                  date: at(project.closedAt),
                })}
              </p>
              {project.closeReason && (
                <div className="grid gap-1">
                  <h3 className="text-[0.9rem] font-semibold">{t('reasonTitle')}</h3>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
                    {project.closeReason}
                  </p>
                </div>
              )}
            </Card>
          )}

          {project.status === 'published' && project.reopenedAt && project.reopenReason && (
            <Banner icon={RotateCcwIcon}>
              <p>{t(`reopened.${project.reopenReason}`, { date: at(project.reopenedAt) })}</p>
            </Banner>
          )}

          {kick && project.status === 'matched' && (
            <Card className="gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{tk('title')}</CardTitle>
                <Badge tone={kick.kickoff ? 'ok' : 'warn'}>
                  {kick.kickoff ? tk('recorded') : tk('notRecorded')}
                </Badge>
              </div>
              <p className="text-[0.9rem] text-muted-foreground">
                {tk('teamIntro', {
                  student,
                  company: project.companyName,
                  date: at(kick.selectedAt),
                })}
              </p>
              {kick.kickoff && <KickoffFacts kickoff={kick.kickoff} team />}
              <KickoffForm
                projectId={project.id}
                values={kick.form}
                members={team.map((m) => ({ id: m.id, name: m.name }))}
                recorded={Boolean(kick.kickoff)}
                locked={!['none', 'failed'].includes(kick.agreement.stage)}
              />
              <ul className="grid gap-2 border-t border-line pt-4 text-[0.9rem]">
                {(
                  [
                    [kick.companySigned, tk('check.company', { company: project.companyName })],
                    [Boolean(kick.kickoff), tk('check.kickoff')],
                    [
                      kick.agreement.stage === 'signed',
                      tk(`check.student.${kick.agreement.stage}`, { student }),
                    ],
                  ] as [boolean, string][]
                ).map(([done, label]) => (
                  <li key={label} className="flex items-start gap-2.5">
                    {done ? (
                      <CircleCheckIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-success"
                      />
                    ) : (
                      <CircleIcon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className={done ? undefined : 'text-muted-foreground'}>
                      <span className="sr-only">{done ? tk('done') : tk('notDone')}: </span>
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
              <StartWorkButton
                projectId={project.id}
                ready={Boolean(kick.kickoff) && kick.agreement.stage === 'signed'}
              >
                <Button asChild variant="secondary" size="sm">
                  <Link href="/team/agreements">{tk('openAgreements')}</Link>
                </Button>
              </StartWorkButton>
            </Card>
          )}

          {kick?.kickoff && project.status !== 'matched' && (
            <Card className="gap-4">
              <CardTitle>{tk('title')}</CardTitle>
              <KickoffFacts kickoff={kick.kickoff} team />
              <p className="text-[0.85rem] text-muted-foreground">{tk('teamFixed')}</p>
            </Card>
          )}

          {running && report && (
            <Card className="gap-4">
              <CardTitle>{t('problemTitle')}</CardTitle>
              <Banner tone="warn" icon={TriangleAlertIcon}>
                <p className="font-semibold">
                  {t(`problemKind.${report.kind}`, { student: report.studentName })}
                </p>
                <p className="text-[0.88rem] text-muted-foreground">
                  {t('reportedOn', { date: at(report.createdAt) })}
                </p>
              </Banner>
              <blockquote className="border-l-[3px] border-line py-0.5 pl-3.5 [overflow-wrap:anywhere] whitespace-pre-line">
                {report.note}
              </blockquote>
              <p className="text-[0.88rem] text-muted-foreground">
                {t('choose', { company: project.companyName, student })}
              </p>
              <ProblemPaths
                mode="running"
                projectId={project.id}
                reportId={report.id}
                student={student}
                company={project.companyName}
                today={today}
                dueDay={
                  match?.dueDay && match.dueDay >= today
                    ? addDays(match.dueDay, 7)
                    : addDays(today, 7)
                }
                closeDay={addDays(today, 7)}
              />
            </Card>
          )}

          {running && !report && (
            <Card className="gap-4">
              <CardTitle>{t('dueTitle')}</CardTitle>
              <p className="inline-flex items-center gap-2">
                <ClockIcon aria-hidden="true" className="size-4 text-primary" />
                {match?.dueDay ? day(match.dueDay) : t('dueEmpty')}
              </p>
              <p className="text-[0.88rem] text-muted-foreground">{t('dueIntro')}</p>
              <ProblemPaths
                mode="running"
                projectId={project.id}
                student={student}
                company={project.companyName}
                today={today}
                dueDay={
                  match?.dueDay && match.dueDay >= today
                    ? addDays(match.dueDay, 7)
                    : addDays(today, 7)
                }
                closeDay={addDays(today, 7)}
              />
            </Card>
          )}

          {project.noMatch && (
            <Card className="gap-4">
              <CardTitle>{t('noMatchTitle')}</CardTitle>
              <p>
                {t('noMatchBody', {
                  date: day(project.closesOn),
                  count: project.applications.open,
                })}
              </p>
              <ProblemPaths
                mode="noMatch"
                projectId={project.id}
                student=""
                company={project.companyName}
                today={today}
                dueDay={addDays(today, 7)}
                closeDay={addDays(today, 7)}
              />
            </Card>
          )}

          {project.status !== 'draft' && (
            <Card className="gap-4">
              <div className="grid gap-1">
                <CardTitle>{tn('title')}</CardTitle>
                <p className="text-[0.88rem] text-muted-foreground">
                  {tn('intro', { company: project.companyName })}
                </p>
              </div>
              <NoteForm
                projectId={project.id}
                note={project.noteToCompany ?? ''}
                company={project.companyName}
              />
              {notes.length > 0 && (
                <div className="grid gap-2 border-t border-line pt-4">
                  <h3 className="text-[0.95rem] font-semibold">{tn('history')}</h3>
                  <ol className="grid">
                    {notes.map((n, i) => (
                      <li
                        key={n.id}
                        className="grid gap-0.5 border-b border-line py-2.5 last:border-b-0"
                      >
                        <span className="text-[0.82rem] text-muted-foreground">
                          {at(n.at)}
                          {n.by ? `, ${n.by}` : ''}
                          {i === 0 && n.note ? ` · ${tn('shown')}` : ''}
                        </span>
                        <p className="[overflow-wrap:anywhere] whitespace-pre-line">
                          {n.note ?? <i className="text-muted-foreground">{tn('cleared')}</i>}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </Card>
          )}

          <ActivityCard rows={rows} describe={describe} />
        </div>

        <aside className="grid min-w-0 gap-6">
          <Card className="gap-3">
            <CardTitle>{to('title')}</CardTitle>
            <div>
              <OwnerChip owner={ownerOf(project.ownerId)} />
            </div>
            <p className="text-[0.88rem] text-muted-foreground">
              {!project.ownerId
                ? to('none')
                : project.ownerId === project.companyOwnerId
                  ? to('follows')
                  : project.companyOwnerId
                    ? to('moved', { name: ownerOf(project.companyOwnerId)?.name ?? '' })
                    : to('contact')}
            </p>
            <ReassignForm
              collection="projects"
              id={project.id}
              ownerId={project.ownerId}
              members={team.map((m) => ({ id: m.id, name: m.name }))}
              labels={{
                owner: to('assign'),
                note: to('noteLabel'),
                noteHint: to('noteHint'),
                submit: to('move'),
                pending: to('moving'),
                done: to('moved_toast'),
                choose: to('assign'),
              }}
            />
          </Card>
          <Card className="gap-4">
            <CardTitle>{t('factsTitle')}</CardTitle>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2.5">
              {facts.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
                </div>
              ))}
            </dl>
            {match && match.history.length > 0 && (
              <ul className="grid gap-1 text-[0.85rem] text-muted-foreground">
                {match.history.map((h) => (
                  <li key={h.changedAt}>{t('dueMoved', { from: day(h.from), to: day(h.to) })}</li>
                ))}
              </ul>
            )}
            <div className="grid gap-2.5">
              {project.status === 'published' && (
                <Button asChild variant="normal" className="w-full">
                  <Link href={`/team/matching?project=${project.id}`}>{t('openMatching')}</Link>
                </Button>
              )}
              {running && (
                <Button asChild variant="secondary" className="w-full">
                  <Link href="/team/deliverables">{t('openDeliverables')}</Link>
                </Button>
              )}
            </div>
          </Card>

          {project.pay && (
            <Card className="gap-4">
              <CardTitle>{t('pay.title')}</CardTitle>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2.5">
                <dt className="text-muted-foreground">{t('pay.price')}</dt>
                <dd className="font-medium tabular-nums">
                  {project.pay.fee !== null ? money(project.pay.fee) : t('notSet')}
                </dd>
                <dt className="text-muted-foreground">{t('pay.total')}</dt>
                <dd className="font-medium tabular-nums">
                  {project.pay.fee !== null
                    ? money(priceBreakdown(project.pay.fee).total)
                    : t('notSet')}
                </dd>
                <dt className="text-muted-foreground">{t('pay.studentPay')}</dt>
                <dd className="font-medium tabular-nums">
                  {project.pay.studentPay !== null ? money(project.pay.studentPay) : t('notSet')}
                </dd>
              </dl>
              {project.pay.editable && (
                <PayForm
                  projectId={project.id}
                  fee={project.pay.fee}
                  studentPay={project.pay.studentPay}
                  student={student || t('student')}
                  companySigned={project.pay.companySigned}
                  studentSigned={project.pay.studentSigned}
                  invoice={
                    !project.pay.paymentRow
                      ? { kind: 'none' }
                      : project.pay.invoiceSent
                        ? { kind: 'sent', date: day(project.pay.invoiceSent) }
                        : { kind: 'open' }
                  }
                />
              )}
            </Card>
          )}

          {project.endedMatches.length > 0 && (
            <Card className="gap-3">
              <CardTitle>{t('endedTitle')}</CardTitle>
              <ul className="grid gap-1.5 text-[0.9rem]">
                {project.endedMatches.map((m) => (
                  <li key={m.id}>
                    {t('endedRow', { student: m.studentName, date: at(m.endedAt!) })}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="gap-3">
            <CardTitle>{t('reportsTitle')}</CardTitle>
            {project.reports.length ? (
              <ul className="grid">
                {project.reports.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line py-2 text-[0.9rem] last:border-b-0"
                  >
                    <span>
                      {t('reportRow', { kind: t(`kindWord.${r.kind}`), date: at(r.createdAt) })}
                    </span>
                    <Badge tone={r.status === 'open' ? 'warn' : 'mute'}>
                      {t(`resolution.${r.resolution ?? 'open'}`)}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{t('reportsEmpty')}</p>
            )}
          </Card>
        </aside>
      </div>
    </TeamShell>
  )
}
