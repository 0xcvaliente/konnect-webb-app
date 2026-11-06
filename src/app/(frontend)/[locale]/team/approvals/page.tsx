import { ClockIcon, FileTextIcon, HistoryIcon, InfoIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { Banner } from '@/components/app/Banner'
import { ProjectDetails } from '@/components/app/ProjectDetails'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { STATUS_TONE } from '@/lib/companies/display'
import { formatOrgNumber } from '@/lib/companies/fields'
import { priceBreakdown, VAT_RATE } from '@/lib/money'
import { PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { projectToView } from '@/lib/projects/view'
import { PROFILE_REVIEW_DAYS, SHARE_KEYS } from '@/lib/students/fields'
import { isQueueTab, QUEUE_TABS, type QueueTab } from '@/lib/team/approvalFields'
import {
  type ActivityRow,
  listQueue,
  loadCompanyReview,
  loadProfileReview,
  loadProjectReview,
  type QueueItem,
} from '@/lib/team/approvals'
import { teamCounts } from '@/lib/team/counts'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'
import { promiseState } from '@/lib/workingDays'

import { ActivityCard, DueChip, OwnerChip, QueueList, waitedText } from './QueueParts'
import { CompanyActions, ProfileActions, ProjectActions, PublishAction } from './ReviewActions'

export const dynamic = 'force-dynamic'

/** The queue's address, keeping only what is set. */
const queueHref = (tab: QueueTab, mine: boolean, item?: number) => {
  const params = new URLSearchParams()
  if (tab !== 'companies') params.set('tab', tab)
  if (mine) params.set('who', 'mine')
  if (item) params.set('item', String(item))
  const query = params.toString()
  return `/team/approvals${query ? `?${query}` : ''}`
}

/**
 * The team's approval queue ("Konnected team daily work" mockup, Approvals): three tabs
 * (companies, projects, student profiles), oldest first, each item with its owner on the team (or
 * the shared pool) and how long it has waited, and the review of the selected item. Nothing
 * reaches students until Konnected approves the company and the project. Every decision is checked
 * again on the server, written to the activity log and emailed.
 */
export default async function TeamApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ tab?: string; who?: string; item?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const search = await searchParams
  const tab: QueueTab = isQueueTab(search.tab) ? search.tab : 'companies'
  const mine = search.who === 'mine'
  const asked = Number(search.item)

  const t = await getTranslations('TeamApprovals')
  const tRole = await getTranslations('Roles')

  const [lists, counts] = await Promise.all([
    Promise.all(QUEUE_TABS.map((key) => listQueue(payload, user, key, { mine: false }))),
    teamCounts(payload, user),
  ])
  const all = Object.fromEntries(QUEUE_TABS.map((key, i) => [key, lists[i] ?? []])) as Record<
    QueueTab,
    QueueItem[]
  >
  const open = (items: QueueItem[]) => items.filter((item) => item.section !== 'waiting').length
  const items = all[tab].filter((item) => !mine || item.owner?.id === user.id)
  const selectedId =
    Number.isInteger(asked) && asked > 0
      ? asked
      : (items.find((item) => item.section !== 'waiting')?.id ?? items[0]?.id ?? null)

  const detail =
    selectedId === null
      ? null
      : tab === 'companies'
        ? await CompanyDetail({ id: selectedId, tab, mine, payload, user })
        : tab === 'projects'
          ? await ProjectDetail({ id: selectedId, tab, mine, payload, user })
          : await ProfileDetail({ id: selectedId, tab, mine, payload, user })

  return (
    <TeamShell
      current="approvals"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team', label: t('back') }}
      title={t('title')}
      lede={t('lede')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label={t('tabsLabel')}
          className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-surface-2 p-1"
        >
          {QUEUE_TABS.map((key) => (
            <Link
              key={key}
              href={queueHref(key, mine)}
              prefetch={false}
              aria-current={key === tab ? 'page' : undefined}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[0.92rem] font-semibold whitespace-nowrap text-muted-foreground no-underline hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-[0_1px_3px_color-mix(in_srgb,var(--ink)_14%,transparent)] sm:min-h-[38px]"
            >
              {t(`tabs.${key}`)}
              <span className="tabular-nums">({open(all[key])})</span>
            </Link>
          ))}
        </nav>
        <div
          role="group"
          aria-label={t('whoLabel')}
          className="inline-flex rounded-full border-[1.5px] border-line p-0.5"
        >
          {([false, true] as const).map((value) => (
            <Link
              key={String(value)}
              href={queueHref(tab, value)}
              prefetch={false}
              aria-current={value === mine ? 'true' : undefined}
              className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[0.85rem] font-semibold text-muted-foreground no-underline aria-[current=true]:bg-tint aria-[current=true]:text-tint-foreground sm:min-h-8"
            >
              {value ? t('mine') : t('everyone')}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 min-[1100px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <QueueList
          tab={tab}
          items={items}
          selectedId={selectedId}
          hrefFor={(id) => `${queueHref(tab, mine, id)}#review`}
          mine={mine}
        />
        <div id="review" className="grid min-w-0 scroll-mt-4 gap-5">
          {detail ?? (
            <Card className="gap-3">
              <CardTitle>{t('emptyTitle')}</CardTitle>
              <p className="text-muted-foreground">{t(`emptyBody.${tab}`)}</p>
              <div>
                <Button asChild variant="secondary">
                  <Link href="/team">{t('back')}</Link>
                </Button>
              </div>
            </Card>
          )}
        </div>
      </div>
    </TeamShell>
  )
}

type DetailProps = {
  id: number
  tab: QueueTab
  mine: boolean
  payload: Awaited<ReturnType<typeof requireTeam>>['payload']
  user: Awaited<ReturnType<typeof requireTeam>>['user']
}

/** A list of facts: label left, value right; stacked on a phone. */
function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-[18px] gap-y-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mb-1.5 font-medium [overflow-wrap:anywhere] sm:mb-0">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The words for an activity row, shared by the three kinds of item. */
async function describer() {
  const t = await getTranslations('TeamApprovals.activity')
  const company = await getTranslations('CompanyFields.status')
  const project = await getTranslations('ProjectStatus.pill')
  const review = await getTranslations('TeamApprovals.reviewStatus')
  const pay = await getTranslations('TeamApprovals.project.pay')
  const word = (value: string | null | undefined): string => {
    if (!value) return ''
    if (company.has(value as never)) return company(value as never)
    if (project.has(value as never)) return project(value as never)
    if (review.has(value as never)) return review(value as never)
    return value
  }
  return (row: ActivityRow): string => {
    if (row.action === 'create') return t('create')
    if (row.action === 'delete') return t('delete')
    if (row.action === 'info_requested') return t('infoRequested')
    if (row.action === 'info_answered') return t('infoAnswered')
    if (row.action === 'review_change') {
      if (row.field === 'fee') {
        return row.toStatus ? t('price', { price: row.toStatus }) : t('priceCleared')
      }
      if (row.field === 'paidOrUnpaid' && (row.toStatus === 'paid' || row.toStatus === 'unpaid')) {
        return t('pay', { choice: pay(row.toStatus) })
      }
      if (row.field === 'reviewedAt') return t('reviewedAgain')
      return t('other')
    }
    if (row.action === 'status_change' && row.toStatus) {
      return row.fromStatus
        ? t('status', { from: word(row.fromStatus), to: word(row.toStatus) })
        : t('statusTo', { to: word(row.toStatus) })
    }
    return t('other')
  }
}

/** The day of a date, in Oslo. */
async function dayOf(value: string | null | undefined): Promise<string | null> {
  if (!value) return null
  const format = await getFormatter()
  return format.dateTime(new Date(value), { dateStyle: 'medium', timeZone: 'Europe/Oslo' })
}

function NoteQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="border-l-[3px] border-line py-0.5 pl-3.5 [overflow-wrap:anywhere] whitespace-pre-line">
      {children}
    </blockquote>
  )
}

// ---------- Company ----------

async function CompanyDetail({ id, tab, mine, payload, user }: DetailProps) {
  const view = await loadCompanyReview(payload, user, id)
  if (!view) return null
  const t = await getTranslations('TeamApprovals')
  const tc = await getTranslations('TeamApprovals.company')
  const f = await getTranslations('CompanyFields')
  const describe = await describer()
  const { company } = view
  const since = company.infoRequestedAt ?? company.reviewRequestedAt ?? company.createdAt
  const pending = company.status === 'pending'
  const waiting = Boolean(company.infoRequestedAt)

  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <CompanyAvatar name={company.name} logoUrl={view.logoUrl} />
            <div className="min-w-0">
              <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{company.name}</h2>
              <p className="text-[0.85rem] text-muted-foreground">
                {tc('registered', { date: (await dayOf(company.createdAt)) ?? '' })}
                {pending && `, ${await waitedText(since)}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnerChip owner={view.owner} />
            <Badge tone={STATUS_TONE[company.status]}>{f(`status.${company.status}`)}</Badge>
          </div>
        </div>

        {view.sameNumber.length > 0 && (
          <Banner tone="warn">
            <p className="font-semibold">{tc('sameNumberTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">
              {tc('sameNumberBody', {
                names: view.sameNumber
                  .map((c) => `${c.name} (${f(`status.${c.status}`)})`)
                  .join(', '),
              })}
            </p>
          </Banner>
        )}
        {waiting && (
          <Banner tone="info" icon={ClockIcon}>
            <p className="font-semibold">
              {tc('waitingTitle', { date: (await dayOf(company.infoRequestedAt)) ?? '' })}
            </p>
            {company.noteToCompany && <NoteQuote>{company.noteToCompany}</NoteQuote>}
            <p className="text-[0.88rem] text-muted-foreground">{tc('waitingBody')}</p>
          </Banner>
        )}
        {pending && company.resentAt && (
          <Banner tone="info" icon={HistoryIcon}>
            <p className="font-semibold">
              {tc('resentTitle', { date: (await dayOf(company.resentAt)) ?? '' })}
            </p>
            {company.noteToCompany && (
              <>
                <p className="text-[0.88rem] text-muted-foreground">{tc('resentNote')}</p>
                <NoteQuote>{company.noteToCompany}</NoteQuote>
              </>
            )}
          </Banner>
        )}
        {!pending && (
          <Banner tone={company.status === 'approved' ? 'ok' : 'bad'}>
            <p className="font-semibold">{tc(`decided.${company.status}`)}</p>
            {company.status === 'rejected' && company.noteToCompany && (
              <NoteQuote>{company.noteToCompany}</NoteQuote>
            )}
          </Banner>
        )}

        {company.description && (
          <p className="[overflow-wrap:anywhere] whitespace-pre-line">{company.description}</p>
        )}
        <Facts
          rows={[
            [
              f('orgNumber'),
              company.orgNumber ? formatOrgNumber(company.orgNumber) : tc('missing'),
            ],
            [
              f('website'),
              company.website ? (
                <a href={company.website} target="_blank" rel="noopener noreferrer nofollow">
                  {company.website.replace(/^https?:\/\//, '')}
                </a>
              ) : (
                tc('missing')
              ),
            ],
            [f('sector'), company.sector ? f(`sectorOption.${company.sector}`) : tc('missing')],
            [
              tc('contact'),
              [company.contactName, company.contactRole, view.contactEmail]
                .filter(Boolean)
                .join(', ') || tc('missing'),
            ],
          ]}
        />
        {pending && (
          <CompanyActions
            key={`${company.id}-${waiting}`}
            id={company.id}
            name={company.name}
            queueHref={queueHref(tab, mine)}
            canAskInfo={!waiting}
          />
        )}
      </Card>
      <ActivityCard rows={view.activity} describe={describe} />
      <p className="text-[0.85rem] text-muted-foreground">{t('checkedHere')}</p>
    </>
  )
}

// ---------- Project ----------

async function ProjectDetail({ id, tab, mine, payload, user }: DetailProps) {
  const view = await loadProjectReview(payload, user, id)
  if (!view) return null
  const t = await getTranslations('TeamApprovals')
  const tp = await getTranslations('TeamApprovals.project')
  const s = await getTranslations('ProjectStatus')
  const f = await getTranslations('CompanyFields')
  const format = await getFormatter()
  const describe = await describer()
  const { project, company } = view
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  const price = project.paidOrUnpaid === 'paid' && project.fee ? priceBreakdown(project.fee) : null

  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{project.title}</h2>
            <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {[
                company?.name ?? project.companyName,
                project.submittedAt
                  ? tp('sent', { date: (await dayOf(project.submittedAt)) ?? '' })
                  : null,
                project.status === 'submitted' && project.submittedAt
                  ? await waitedText(project.submittedAt)
                  : null,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnerChip owner={view.owner} />
            <Badge tone={PROJECT_STATUS_TONE[project.status]}>{s(`pill.${project.status}`)}</Badge>
          </div>
        </div>

        {project.status === 'changes_requested' && (
          <Banner tone="info" icon={ClockIcon}>
            <p className="font-semibold">
              {tp('waitingTitle', {
                name: company?.name ?? '',
                date: (await dayOf(project.noteToCompanyAt)) ?? '',
              })}
            </p>
            {project.noteToCompany && <NoteQuote>{project.noteToCompany}</NoteQuote>}
            <p className="text-[0.88rem] text-muted-foreground">{tp('waitingBody')}</p>
          </Banner>
        )}
        {project.status === 'rejected' && (
          <Banner tone="bad">
            <p className="font-semibold">{tp('rejectedTitle')}</p>
            {project.noteToCompany && <NoteQuote>{project.noteToCompany}</NoteQuote>}
          </Banner>
        )}
        {project.paidOrUnpaid === 'unpaid' && project.status === 'submitted' && (
          <Banner tone="info" icon={InfoIcon}>
            <p className="text-[0.88rem]">{tp('unpaidBanner')}</p>
          </Banner>
        )}
        {company && company.status !== 'approved' && (
          <Banner tone="warn">
            <p className="text-[0.88rem]">
              {tp('companyNotApproved', { status: f(`status.${company.status}`) })}
            </p>
          </Banner>
        )}

        <Facts
          rows={[
            [
              tp('company'),
              `${company?.name ?? project.companyName ?? ''}${company ? ` (${f(`status.${company.status}`)})` : ''}`,
            ],
            // In review the company's choice shows with the answers below; after the review this
            // is Konnected's decision.
            ...(project.status === 'submitted'
              ? []
              : ([
                  [
                    tp('payment'),
                    project.paidOrUnpaid ? tp(`pay.${project.paidOrUnpaid}`) : tp('payNone'),
                  ],
                ] as [string, ReactNode][])),
            ...(price
              ? ([
                  [
                    tp('priceSet'),
                    tp('priceLine', {
                      price: money(price.price),
                      vat: money(price.vat),
                      total: money(price.total),
                      rate: VAT_RATE * 100,
                    }),
                  ],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
        <ProjectDetails project={projectToView(project)} />

        {project.status === 'submitted' && (
          <ProjectActions
            key={project.id}
            id={project.id}
            title={project.title}
            companyChoice={project.paidOrUnpaid ?? null}
            itemHref={queueHref(tab, mine, project.id)}
            queueHref={queueHref(tab, mine)}
          />
        )}
        {project.status === 'approved' && (
          <div className="grid gap-3 border-t border-line pt-4">
            <p className="font-semibold">{tp('publishTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{tp('publishBody')}</p>
            <PublishAction
              key={project.id}
              id={project.id}
              title={project.title}
              queueHref={queueHref(tab, mine)}
            />
          </div>
        )}
      </Card>
      <ActivityCard rows={view.activity} describe={describe} />
      <p className="text-[0.85rem] text-muted-foreground">{t('checkedHere')}</p>
    </>
  )
}

// ---------- Student profile ----------

const REVIEW_TONE = { waiting: 'warn', changes_requested: 'info', reviewed: 'ok' } as const

async function ProfileDetail({ id, tab, mine, payload, user }: DetailProps) {
  const view = await loadProfileReview(payload, user, id)
  if (!view) return null
  const t = await getTranslations('TeamApprovals')
  const tp = await getTranslations('TeamApprovals.profile')
  const sf = await getTranslations('StudentFields')
  const format = await getFormatter()
  const describe = await describer()
  const { profile } = view
  const status = profile.reviewStatus ?? 'waiting'
  const since = profile.reviewRequestedAt ?? profile.createdAt
  const changed = status === 'reviewed' && Boolean(profile.changedSinceReviewAt)
  const due = status === 'waiting' ? promiseState(new Date(since), PROFILE_REVIEW_DAYS) : null

  const list = (values: string[] | null | undefined, label: (v: string) => string) =>
    values?.length ? values.map(label).join(', ') : tp('missing')
  const interest = (v: string) =>
    sf.has(`interest.${v}` as never) ? sf(`interest.${v}` as never) : v
  const projectType = (v: string) =>
    sf.has(`projectType.${v}` as never) ? sf(`projectType.${v}` as never) : v

  /** A snapshot value as short text for "what changed". */
  const shown = (field: string, value: unknown): string => {
    if (value === null || value === undefined || value === '') return tp('empty')
    if (field === 'cv') return tp('cvFile')
    if (field === 'privacy' && typeof value === 'object') {
      const on = SHARE_KEYS.filter((k) => (value as Record<string, boolean>)[k])
      return on.length ? on.map((k) => sf(`share.${k}`)).join(', ') : tp('sharesNothing')
    }
    if (field === 'interests' && Array.isArray(value)) return value.map(interest).join(', ')
    if (field === 'preferredProjectTypes' && Array.isArray(value)) {
      return value.map(projectType).join(', ')
    }
    if (field === 'year' && typeof value === 'number') {
      return sf.has(`yearOption.${value}` as never)
        ? sf(`yearOption.${value}` as never)
        : String(value)
    }
    const text = Array.isArray(value) ? value.join(', ') : String(value)
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
  const fieldLabel = (field: string) =>
    field === 'privacy'
      ? tp('sharing')
      : field === 'cv'
        ? tp('cv')
        : field === 'preferredProjectTypes'
          ? sf('projectTypes')
          : sf(field as never)

  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-full bg-tint text-[0.9rem] font-bold text-tint-foreground"
            >
              {profile.name
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2)
                .map((p) => p[0]!.toUpperCase())
                .join('')}
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{profile.name}</h2>
              <p className="text-[0.85rem] text-muted-foreground">
                {tp('signedUp', { date: (await dayOf(profile.createdAt)) ?? '' })}
                {status === 'waiting' && `, ${await waitedText(since)}`}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnerChip owner={null} />
            {due && <DueChip due={due} />}
            <Badge tone={changed ? 'warn' : REVIEW_TONE[status]}>
              {changed ? tp('changedPill') : t(`reviewStatus.${status}`)}
            </Badge>
          </div>
        </div>

        {status === 'changes_requested' && (
          <Banner tone="info" icon={ClockIcon}>
            <p className="font-semibold">
              {tp('waitingTitle', { date: (await dayOf(profile.reviewNoteAt)) ?? '' })}
            </p>
            {profile.reviewNote && <NoteQuote>{profile.reviewNote}</NoteQuote>}
            <p className="text-[0.88rem] text-muted-foreground">{tp('waitingBody')}</p>
          </Banner>
        )}
        {status === 'reviewed' && !changed && (
          <Banner tone="ok">
            <p className="font-semibold">
              {tp('reviewedOn', { date: (await dayOf(profile.reviewedAt)) ?? '' })}
            </p>
          </Banner>
        )}

        {view.changes.length > 0 && (
          <section
            aria-labelledby={`changes-${profile.id}`}
            className="grid gap-2 rounded-item bg-surface-2 p-4"
          >
            <h3 id={`changes-${profile.id}`} className="font-semibold">
              {tp('changesTitle', { date: (await dayOf(profile.reviewedAt)) ?? '' })}
            </h3>
            <ul className="grid gap-2">
              {view.changes.map((change) => (
                <li key={change.field} className="grid gap-0.5">
                  <span className="text-[0.88rem] font-semibold">{fieldLabel(change.field)}</span>
                  <span className="text-[0.88rem] [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground line-through decoration-1">
                      <span className="sr-only">{tp('before')} </span>
                      {shown(change.field, change.before)}
                    </span>
                    <span aria-hidden="true"> → </span>
                    <span>
                      <span className="sr-only">{tp('after')} </span>
                      {shown(change.field, change.after)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Facts
          rows={[
            [tp('email'), view.email ?? tp('missing')],
            [sf('school'), profile.school || tp('missing')],
            [
              sf('programme'),
              [
                profile.programme,
                profile.year && sf.has(`yearOption.${profile.year}` as never)
                  ? sf(`yearOption.${profile.year}` as never)
                  : null,
              ]
                .filter(Boolean)
                .join(', ') || tp('missing'),
            ],
            [sf('interests'), list(profile.interests, interest)],
            [sf('skills'), list(profile.skills, (v) => v)],
            [sf('projectTypes'), list(profile.preferredProjectTypes, projectType)],
            [sf('pitch'), profile.pitch || tp('missing')],
            [sf('experience'), profile.experience || tp('missing')],
            [sf('highlights'), profile.highlights || tp('missing')],
            [sf('contactEmail'), profile.contactEmail || tp('missing')],
            [sf('phone'), profile.phone || tp('missing')],
            [tp('applications'), String(view.applications)],
          ]}
        />

        {view.cv ? (
          <div className="flex flex-wrap items-center gap-3 rounded-item border-[1.5px] border-line px-3.5 py-3">
            <FileTextIcon aria-hidden="true" className="size-5 text-primary" />
            <div className="min-w-0 flex-1">
              <b className="block font-semibold [overflow-wrap:anywhere]">{view.cv.name}</b>
              {view.cv.filesize ? (
                <small className="text-[0.82rem] text-muted-foreground">
                  {format.number(Math.max(1, Math.round(view.cv.filesize / 1024)))} KB
                </small>
              ) : null}
            </div>
            {view.cv.url && (
              <Button asChild size="sm" variant="secondary">
                {/* The access-checked file route: the browser downloads it with the session. */}
                <a href={view.cv.url}>{tp('openCv')}</a>
              </Button>
            )}
          </div>
        ) : (
          <Banner tone="warn">
            <p className="font-semibold">{tp('noCvTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{tp('noCvBody')}</p>
          </Banner>
        )}

        <section aria-labelledby={`share-${profile.id}`} className="grid gap-1.5">
          <h3 id={`share-${profile.id}`} className="text-[0.88rem] font-semibold">
            {tp('sharedTitle')}
          </h3>
          <ul className="grid">
            {SHARE_KEYS.map((key) => {
              const on = profile.privacy?.[key] === true
              return (
                <li
                  key={key}
                  className={cn(
                    'flex items-center gap-2.5 border-b border-line py-2 text-[0.9rem] last:border-b-0',
                    !on && 'text-muted-foreground',
                  )}
                >
                  <span aria-hidden="true">{on ? '✓' : '–'}</span>
                  <span>{sf(`share.${key}`)}</span>
                  <span className="sr-only">{on ? tp('shared') : tp('notShared')}</span>
                </li>
              )
            })}
          </ul>
        </section>
        <p className="text-[0.85rem] text-muted-foreground">{tp('noAutoCheck')}</p>

        {(status === 'waiting' || changed || status === 'changes_requested') && (
          <ProfileActions
            key={`${profile.id}-${status}-${changed}`}
            id={profile.id}
            name={profile.name}
            queueHref={queueHref(tab, mine)}
            again={changed}
            canAsk={status !== 'changes_requested'}
          />
        )}
      </Card>
      <ActivityCard rows={view.activity} describe={describe} />
    </>
  )
}
