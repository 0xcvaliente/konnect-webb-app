import {
  BriefcaseIcon,
  CalendarClockIcon,
  CheckIcon,
  CircleCheckIcon,
  FileTextIcon,
  UsersIcon,
} from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { TeamShell } from '@/components/app/TeamShell'
import { Banner } from '@/components/app/Banner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { APPLICATION_STATUS_TONE, MAX_RUNNING_PROJECTS } from '@/lib/applications/fields'
import { skillHits } from '@/lib/matching/fields'
import { PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { teamCounts } from '@/lib/team/counts'
import {
  type Applicant,
  listMatchingQueue,
  loadMatchingProject,
  type MatchingItem,
  type MatchingProject,
} from '@/lib/team/matching'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'

import { ActivityCard, DueChip, OwnerChip } from '../approvals/QueueParts'
import { SelectBox, ShortlistButton } from './MatchingActions'

export const dynamic = 'force-dynamic'

/** The screen's address, keeping only what is set. */
const matchingHref = (mine: boolean, project?: number) => {
  const params = new URLSearchParams()
  if (mine) params.set('who', 'mine')
  if (project) params.set('project', String(project))
  const query = params.toString()
  return `/team/matching${query ? `?${query}` : ''}`
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

/**
 * Matching ("Konnected team daily work" mockup, Matching): Konnected picks one student per project
 * by hand. The published projects with applications to decide, oldest promise first, each with
 * its owner on the team and the decision countdown; for one project, its brief beside the
 * applicants, compared side by side (skills asked for, hit or missed; running projects, x of 2;
 * hours already promised elsewhere; first project with Konnected), then shortlist or select.
 *
 * Companies never see this: they see only the selected student, through what the student agreed
 * to share. Every decision is checked again on the server and written to the activity log.
 */
export default async function TeamMatchingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ who?: string; project?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const search = await searchParams
  const mine = search.who === 'mine'
  const asked = /^\d{1,10}$/.test(search.project ?? '') ? Number(search.project) : null

  const t = await getTranslations('TeamMatching')
  const tRole = await getTranslations('Roles')
  const [all, counts] = await Promise.all([
    listMatchingQueue(payload, user),
    teamCounts(payload, user),
  ])
  const items = (all ?? []).filter((item) => !mine || item.owner?.id === user.id)
  const selectedId = asked ?? items[0]?.id ?? null
  const view = selectedId ? await loadMatchingProject(payload, user, selectedId) : null
  const next = items.find((item) => item.id !== selectedId)

  return (
    <TeamShell
      current="matching"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team', label: t('back') }}
      title={t('title')}
      lede={t('lede')}
    >
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div
          role="group"
          aria-label={t('whoLabel')}
          className="inline-flex rounded-full border-[1.5px] border-line p-0.5"
        >
          {([false, true] as const).map((value) => (
            <Link
              key={String(value)}
              href={matchingHref(value)}
              prefetch={false}
              aria-current={value === mine ? 'true' : undefined}
              className="inline-flex min-h-11 items-center rounded-full px-3.5 text-[0.85rem] font-semibold text-muted-foreground no-underline aria-[current=true]:bg-tint aria-[current=true]:text-tint-foreground sm:min-h-8"
            >
              {value ? t('mine') : t('everyone')}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 min-[1100px]:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <QueueList items={items} selectedId={selectedId} mine={mine} />
        <div id="project" className="grid min-w-0 scroll-mt-4 gap-5">
          {view ? (
            <ProjectDetail
              view={view}
              mine={mine}
              nextHref={next ? `${matchingHref(mine, next.id)}#project` : null}
            />
          ) : (
            <Card className="gap-3">
              <CardTitle>{t('emptyTitle')}</CardTitle>
              <p className="text-muted-foreground">{t('emptyBody')}</p>
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

/** A day (`YYYY-MM-DD`) in words, in Oslo. */
async function dayText(day: string | null, style: 'medium' | 'long' = 'medium') {
  if (!day) return null
  const format = await getFormatter()
  const [y, m, d] = day.split('-').map(Number)
  return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
    dateStyle: style,
    timeZone: 'Europe/Oslo',
  })
}

async function QueueList({
  items,
  selectedId,
  mine,
}: {
  items: MatchingItem[]
  selectedId: number | null
  mine: boolean
}) {
  const t = await getTranslations('TeamMatching')
  if (!items.length) {
    return (
      <p className="rounded-item border-[1.5px] border-dashed border-line p-4 text-[0.88rem] text-muted-foreground">
        {mine ? t('queueEmptyMine') : t('queueEmpty')}
      </p>
    )
  }
  const sections = (['decide', 'open'] as const).filter((s) =>
    items.some((item) => item.section === s),
  )
  return (
    <div className="grid content-start gap-4">
      {await Promise.all(
        sections.map(async (section) => {
          const list = items.filter((item) => item.section === section)
          return (
            <section key={section} aria-labelledby={`matching-${section}`} className="grid gap-2">
              <h2
                id={`matching-${section}`}
                className="px-0.5 text-[0.82rem] font-semibold text-muted-foreground"
              >
                {t(`section.${section}`)} <span className="tabular-nums">({list.length})</span>
              </h2>
              <ul className="grid gap-2">
                {await Promise.all(
                  list.map(async (item) => {
                    const selected = item.id === selectedId
                    const closes = await dayText(item.closesOn)
                    return (
                      <li key={item.id}>
                        <Link
                          href={`${matchingHref(mine, item.id)}#project`}
                          prefetch={false}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'grid min-h-11 gap-1 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3 text-foreground no-underline transition-colors hover:bg-surface-2',
                            selected && 'border-transparent bg-tint hover:bg-tint',
                          )}
                        >
                          <b className="font-semibold [overflow-wrap:anywhere]">{item.title}</b>
                          <small className="text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                            {[
                              item.companyName,
                              t('applications', { count: item.open }),
                              closes
                                ? item.section === 'decide'
                                  ? t('closed', { date: closes })
                                  : t('closes', { date: closes })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(', ')}
                          </small>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <OwnerChip owner={item.owner} />
                            {item.due && <DueChip due={item.due} />}
                            {item.shortlisted > 0 && (
                              <Badge variant="tag">
                                {t('shortlistedTag', { count: item.shortlisted })}
                              </Badge>
                            )}
                          </span>
                        </Link>
                      </li>
                    )
                  }),
                )}
              </ul>
            </section>
          )
        }),
      )}
    </div>
  )
}

/** Label left, value right; stacked on a phone. */
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

async function ProjectDetail({
  view,
  mine,
  nextHref,
}: {
  view: MatchingProject
  mine: boolean
  nextHref: string | null
}) {
  const t = await getTranslations('TeamMatching')
  const tItems = await getTranslations('SharedItems.inline')
  const tf = await getTranslations('ProjectFields')
  const s = await getTranslations('ProjectStatus')
  const ts = await getTranslations('ApplicationStatus')
  const tAct = await getTranslations('TeamApprovals.activity')
  const format = await getFormatter()
  const { project, applicants } = view
  const closes = await dayText(view.closesOn, 'long')
  const decideBy = await dayText(view.decideBy, 'long')
  const published = project.status === 'published'
  const company = project.companyName ?? ''
  const skills = project.desiredSkills ?? []
  const describe = (row: {
    action: string
    fromStatus?: string | null
    toStatus?: string | null
  }) =>
    row.action === 'create'
      ? tAct('create')
      : row.action === 'status_change' && row.toStatus
        ? s.has(`pill.${row.toStatus}` as never)
          ? tAct('statusTo', { to: s(`pill.${row.toStatus}` as never) })
          : tAct('other')
        : tAct('other')

  const brief = (
    <Card className="gap-4 min-[1500px]:sticky min-[1500px]:top-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{project.title}</h2>
          <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">{company}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OwnerChip owner={view.owner} />
          <Badge tone={PROJECT_STATUS_TONE[project.status]}>{s(`pill.${project.status}`)}</Badge>
        </div>
      </div>
      {published && (
        <Banner icon={CalendarClockIcon} tone={view.due?.tone === 'late' ? 'bad' : 'info'}>
          <p className="font-semibold">
            {decideBy ? t('decideBy', { date: decideBy }) : t('decideNoDate')}
          </p>
          <p className="text-[0.88rem] text-muted-foreground">
            {closes ? t('closesOn', { date: closes }) : t('noClosingDay')}
          </p>
          {view.due && (
            <div className="pt-1.5">
              <DueChip due={view.due} />
            </div>
          )}
        </Banner>
      )}
      <Facts
        rows={[
          [
            t('workload'),
            project.workloadHours ? tf('hours', { count: project.workloadHours }) : t('missing'),
          ],
          [
            t('timeframe'),
            project.durationWeeks ? tf('weeks', { count: project.durationWeeks }) : t('missing'),
          ],
          [t('payment'), project.paidOrUnpaid ? t(`pay.${project.paidOrUnpaid}`) : t('missing')],
        ]}
      />
      <div className="grid gap-1.5">
        <h3 className="text-[0.88rem] font-semibold">{t('skillsAsked')}</h3>
        {skills.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {skills.map((skill) => (
              <li key={skill}>
                <Badge variant="tag">{skill}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t('missing')}</p>
        )}
      </div>
      {project.description && (
        <div className="grid gap-1">
          <h3 className="text-[0.88rem] font-semibold">{t('work')}</h3>
          <p className="line-clamp-6 text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
            {project.description}
          </p>
        </div>
      )}
      {project.deliverable && (
        <div className="grid gap-1">
          <h3 className="text-[0.88rem] font-semibold">{t('deliverable')}</h3>
          <p className="line-clamp-4 text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
            {project.deliverable}
          </p>
        </div>
      )}
    </Card>
  )

  return (
    <>
      {view.match && (
        <Banner tone="ok" icon={CircleCheckIcon} role="status">
          <p className="font-semibold">
            {t('matchedTitle', {
              name: view.match.name,
              date: format.dateTime(new Date(view.match.at), {
                dateStyle: 'medium',
                timeZone: 'Europe/Oslo',
              }),
            })}
          </p>
          <p className="text-[0.88rem] text-muted-foreground">
            {view.match.shares.length
              ? t('matchedShares', {
                  company,
                  items: format.list(
                    view.match.shares.map((item) => tItems(item)),
                    { type: 'conjunction' },
                  ),
                })
              : t('matchedSharesNothing', { company })}
          </p>
          {nextHref && (
            <Button asChild size="sm" className="mt-2">
              <Link href={nextHref}>{t('next')}</Link>
            </Button>
          )}
        </Banner>
      )}

      <div className="grid items-start gap-5 min-[1500px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        {brief}
        <section aria-labelledby="applicants" className="grid min-w-0 gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="applicants" className="text-base font-semibold">
              {t('applicantsTitle', { count: applicants.length })}
            </h2>
            {published && applicants.length > 0 && (
              <p className="text-[0.85rem] text-muted-foreground">{t('applicantsHint')}</p>
            )}
          </div>
          {applicants.length === 0 ? (
            <p className="rounded-item border-[1.5px] border-dashed border-line p-4 text-[0.88rem] text-muted-foreground">
              {view.match ? t('noneLeftMatched') : t('noneOpen')}
            </p>
          ) : (
            <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,264px),1fr))]">
              {await Promise.all(
                applicants.map(async (a) => (
                  <li key={a.applicationId} className="min-w-0">
                    <ApplicantCard
                      applicant={a}
                      skills={skills}
                      company={company}
                      published={published}
                      others={applicants.length - 1}
                      projectTitle={project.title}
                      queueHref={`${matchingHref(mine, project.id)}#project`}
                    />
                  </li>
                )),
              )}
            </ul>
          )}

          {view.decided.length > 0 && (
            <Card className="gap-2 p-[18px] sm:p-5">
              <h3 className="text-[0.9rem] font-semibold">{t('decidedTitle')}</h3>
              <ul className="grid">
                {view.decided.map((d) => (
                  <li
                    key={d.applicationId}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0"
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">{d.name}</span>
                    <Badge tone={APPLICATION_STATUS_TONE[d.status]}>{ts(d.status)}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
      <ActivityCard rows={view.activity} describe={describe} />
      <p className="text-[0.85rem] text-muted-foreground">{t('checkedHere')}</p>
    </>
  )
}

async function ApplicantCard({
  applicant: a,
  skills,
  company,
  published,
  others,
  projectTitle,
  queueHref,
}: {
  applicant: Applicant
  skills: string[]
  company: string
  published: boolean
  others: number
  projectTitle: string
  queueHref: string
}) {
  const t = await getTranslations('TeamMatching')
  const tItems = await getTranslations('SharedItems.inline')
  const ts = await getTranslations('ApplicationStatus')
  const sf = await getTranslations('StudentFields')
  const format = await getFormatter()
  const hits = skillHits(skills, a.skills)
  const hitCount = hits.filter(Boolean).length
  const full = a.running >= MAX_RUNNING_PROJECTS
  const study = [
    a.programme,
    a.year && sf.has(`yearOption.${a.year}` as never) ? sf(`yearOption.${a.year}` as never) : null,
    a.school,
  ]
    .filter(Boolean)
    .join(', ')
  const first = a.name.split(/\s+/)[0] ?? a.name

  return (
    <article
      aria-labelledby={`applicant-${a.applicationId}`}
      className="grid h-full content-start gap-3.5 rounded-item border-[1.5px] border-line bg-surface p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-tint text-[0.85rem] font-bold text-tint-foreground"
          >
            {initials(a.name)}
          </span>
          <div className="min-w-0">
            <h3
              id={`applicant-${a.applicationId}`}
              className="font-semibold [overflow-wrap:anywhere]"
            >
              {a.name}
            </h3>
            <p className="text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
              {study || t('noStudy')}
            </p>
          </div>
        </div>
        <Badge tone={APPLICATION_STATUS_TONE[a.status]}>{ts(a.status)}</Badge>
      </div>

      {(a.firstProject || a.changedSinceReview) && (
        <div className="flex flex-wrap gap-1.5">
          {a.firstProject && <Badge variant="new">{t('firstProject')}</Badge>}
          {a.changedSinceReview && <Badge tone="warn">{t('changedSinceReview')}</Badge>}
        </div>
      )}

      <div className="grid gap-1.5">
        <p className="text-[0.82rem] font-semibold text-muted-foreground">
          {t('skillsHit', { hit: hitCount, total: skills.length })}
        </p>
        {skills.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t('skillsLabel')}>
            {skills.map((skill, i) => (
              <li key={skill}>
                {hits[i] ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--ok)_14%,var(--surface))] px-2.5 h-6 text-tag text-foreground">
                    <CheckIcon aria-hidden="true" className="size-3 text-success" strokeWidth={3} />
                    <span className="sr-only">{t('has')} </span>
                    {skill}
                  </span>
                ) : (
                  <span className="inline-flex items-center rounded-full px-2.5 h-6 text-tag text-muted-foreground shadow-[inset_0_0_0_1px_var(--line)]">
                    <span className="sr-only">{t('missingSkill')} </span>
                    {skill}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.9rem]">
        <dt className="text-muted-foreground">{t('applied')}</dt>
        <dd className="tabular-nums">
          {format.dateTime(new Date(a.appliedAt), {
            dateStyle: 'medium',
            timeZone: 'Europe/Oslo',
          })}
        </dd>
        <dt className="text-muted-foreground">{t('running')}</dt>
        <dd className={cn('tabular-nums', full && 'font-semibold text-destructive')}>
          {t('runningValue', { count: a.running, max: MAX_RUNNING_PROJECTS })}
        </dd>
        <dt className="text-muted-foreground">{t('hours')}</dt>
        <dd className="tabular-nums">
          {a.running ? t('hoursValue', { count: a.runningHours }) : t('hoursNone')}
        </dd>
        <dt className="text-muted-foreground">{t('profile')}</dt>
        <dd className={cn(!a.reviewed && 'font-semibold text-destructive')}>
          {a.reviewed ? t('reviewed') : t('notReviewed')}
        </dd>
      </dl>

      {a.note ? (
        <blockquote className="border-l-[3px] border-line py-0.5 pl-3.5 text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line">
          {a.note}
        </blockquote>
      ) : (
        <p className="text-[0.85rem] text-muted-foreground">{t('noNote')}</p>
      )}

      {published && (
        <div className="mt-auto grid gap-2.5 border-t border-line pt-3.5">
          <div className="flex flex-wrap gap-2">
            {a.canSelect ? (
              <SelectBox
                applicationId={a.applicationId}
                name={a.name}
                first={first}
                others={others}
                company={company}
                projectTitle={projectTitle}
                shares={a.shares.map((item) => tItems(item))}
                queueHref={queueHref}
              />
            ) : !a.reviewed ? (
              <Button asChild size="sm" variant="secondary">
                <Link href={`/team/approvals?tab=students&item=${a.profileId}#review`}>
                  {t('reviewFirst')}
                </Link>
              </Button>
            ) : null}
            {a.status === 'applied' && (
              <ShortlistButton applicationId={a.applicationId} name={a.name} />
            )}
            {a.cv && (
              <Button asChild size="sm" variant="text">
                {/* The access-checked file route; the browser downloads it with the session. */}
                <a href={a.cv.url}>
                  <FileTextIcon aria-hidden="true" className="size-4" />
                  {t('openCv')}
                </a>
              </Button>
            )}
          </div>
          {full && (
            <p className="flex items-start gap-1.5 text-[0.85rem] text-muted-foreground">
              <BriefcaseIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t('fullHint', { max: MAX_RUNNING_PROJECTS })}
            </p>
          )}
          {!a.reviewed && (
            <p className="flex items-start gap-1.5 text-[0.85rem] text-muted-foreground">
              <UsersIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {t('reviewHint')}
            </p>
          )}
        </div>
      )}
    </article>
  )
}
