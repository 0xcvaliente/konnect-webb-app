import { CircleCheckIcon, ClockIcon, WrenchIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { HandInView } from '@/components/app/deliverables/HandInView'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { teamCounts } from '@/lib/team/counts'
import {
  type DeliverableItem,
  type DeliverableSection,
  listDeliverableQueue,
  loadTeamDeliverable,
  type TeamDeliverable,
} from '@/lib/team/deliverables'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'

import { ActivityCard, OwnerChip, waitedText } from '../approvals/QueueParts'
import { DeliverableActions } from './DeliverableActions'

export const dynamic = 'force-dynamic'

/** The screen's address, keeping only what is set. */
const deliverablesHref = (mine: boolean, item?: number) => {
  const params = new URLSearchParams()
  if (mine) params.set('who', 'mine')
  if (item) params.set('item', String(item))
  const query = params.toString()
  return `/team/deliverables${query ? `?${query}` : ''}`
}

/** A day (`YYYY-MM-DD`) in words, in Oslo. */
async function dayText(day: string | null) {
  if (!day) return null
  const format = await getFormatter()
  const [y, m, d] = day.split('-').map(Number)
  return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
    dateStyle: 'medium',
    timeZone: 'Europe/Oslo',
  })
}

/**
 * Deliverables ("Konnected team daily work" mockup, Deliverables): students deliver to Konnected.
 * The team checks each hand-in against the project, then releases it to the company or asks the
 * student for more. Released work waits for the company (accept, or one round of fixes within 7
 * days); work the student is fixing waits on the student. Each item shows its owner on the team.
 *
 * The company never sees a hand-in before release: the collection's read rule makes sure of it,
 * whatever this page does. Every decision is checked again on the server and logged.
 */
export default async function TeamDeliverablesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ who?: string; item?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const search = await searchParams
  const mine = search.who === 'mine'
  const asked = /^\d{1,10}$/.test(search.item ?? '') ? Number(search.item) : null

  const t = await getTranslations('TeamDeliverables')
  const tRole = await getTranslations('Roles')
  const [all, counts] = await Promise.all([
    listDeliverableQueue(payload, user, { mine }),
    teamCounts(payload, user),
  ])
  const items = all ?? []
  const selectedId = asked ?? items[0]?.id ?? null
  const view = selectedId ? await loadTeamDeliverable(payload, user, selectedId) : null
  const next = items.find((item) => item.id !== selectedId && item.section === 'check')

  return (
    <TeamShell
      current="deliverables"
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
              href={deliverablesHref(value)}
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
        <div id="item" className="grid min-w-0 scroll-mt-4 gap-5">
          {view ? (
            <Detail view={view} queueHref={`${deliverablesHref(mine, next?.id)}#item`} />
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

async function QueueList({
  items,
  selectedId,
  mine,
}: {
  items: DeliverableItem[]
  selectedId: number | null
  mine: boolean
}) {
  const t = await getTranslations('TeamDeliverables')
  if (!items.length) {
    return (
      <p className="rounded-item border-[1.5px] border-dashed border-line p-4 text-[0.88rem] text-muted-foreground">
        {mine ? t('queueEmptyMine') : t('queueEmpty')}
      </p>
    )
  }
  const sections = (['check', 'student', 'company'] as DeliverableSection[]).filter((s) =>
    items.some((item) => item.section === s),
  )
  return (
    <div className="grid content-start gap-4">
      {await Promise.all(
        sections.map(async (section) => {
          const list = items.filter((item) => item.section === section)
          return (
            <section key={section} aria-labelledby={`dl-${section}`} className="grid gap-2">
              <h2
                id={`dl-${section}`}
                className="px-0.5 text-[0.82rem] font-semibold text-muted-foreground"
              >
                {t(`section.${section}`)} <span className="tabular-nums">({list.length})</span>
              </h2>
              <ul className="grid gap-2">
                {await Promise.all(
                  list.map(async (item) => {
                    const selected = item.id === selectedId
                    const until = await dayText(item.fixUntil)
                    return (
                      <li key={item.id}>
                        <Link
                          href={`${deliverablesHref(mine, item.id)}#item`}
                          prefetch={false}
                          aria-current={selected ? 'true' : undefined}
                          className={cn(
                            'grid min-h-11 gap-1 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3 text-foreground no-underline transition-colors hover:bg-surface-2',
                            selected && 'border-transparent bg-tint hover:bg-tint',
                            section === 'student' && !selected && 'border-dashed',
                          )}
                        >
                          <b className="font-semibold [overflow-wrap:anywhere]">{item.title}</b>
                          <small className="text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                            {[
                              t('studentFor', {
                                student: item.studentName,
                                company: item.companyName ?? '',
                              }),
                              await waitedText(item.since),
                            ].join(', ')}
                          </small>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <OwnerChip owner={item.owner} />
                            {item.fix && <Badge tone="warn">{t('fixTag')}</Badge>}
                            {until && <Badge tone="info">{t('untilTag', { date: until })}</Badge>}
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

async function Detail({ view, queueHref }: { view: TeamDeliverable; queueHref: string }) {
  const t = await getTranslations('TeamDeliverables')
  const td = await getTranslations('Deliverables')
  const s = await getTranslations('ProjectStatus')
  const format = await getFormatter()
  const day = (iso: string | null | undefined) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' }) : ''
  const { handIn, project, state } = view
  const company = project.companyName ?? ''
  const earlier = view.history.filter((h) => h.id !== handIn.id)
  const describe = (row: { action: string; toStatus?: string | null }) =>
    row.action === 'create'
      ? t('activity.create')
      : row.action === 'status_change' &&
          row.toStatus &&
          td.has(`status.team.${row.toStatus}` as never)
        ? t('activity.status', { status: td(`status.team.${row.toStatus}` as never) })
        : t('activity.other')

  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{project.title}</h2>
            <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {t('studentFor', { student: view.studentName, company })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnerChip owner={view.owner} />
            <Badge tone={PROJECT_STATUS_TONE[project.status]}>{s(`pill.${project.status}`)}</Badge>
          </div>
        </div>

        {project.deliverable && (
          <div className="grid gap-1">
            <h3 className="text-[0.88rem] font-semibold">{t('expected')}</h3>
            <p className="text-[0.92rem] [overflow-wrap:anywhere] whitespace-pre-line text-muted-foreground">
              {project.deliverable}
            </p>
          </div>
        )}

        {state.fixOpen && state.current && state.current.id !== handIn.id && (
          <Banner tone="warn" icon={WrenchIcon}>
            <p className="font-semibold">{t('fixRound', { company })}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('fixRoundBody')}</p>
          </Banner>
        )}

        <HandInView handIn={handIn} audience="team" className="border-t border-line pt-4" />

        {handIn.status === 'submitted' ? (
          <div className="border-t border-line pt-4">
            <DeliverableActions
              deliverableId={handIn.id}
              company={company}
              student={view.studentName}
              paid={project.paidOrUnpaid === 'paid'}
              queueHref={queueHref}
            />
          </div>
        ) : handIn.status === 'released' && !state.accepted ? (
          <Banner icon={ClockIcon}>
            <p className="font-semibold">{t('waitingCompany', { company })}</p>
            <p className="text-[0.88rem] text-muted-foreground">
              {state.fixUntil
                ? t('waitingCompanyBody', {
                    company,
                    date: day(`${state.fixUntil}T12:00:00.000Z`),
                  })
                : t('waitingCompanyFixed')}
            </p>
          </Banner>
        ) : (handIn.status === 'returned' || handIn.status === 'fix_requested') &&
          state.canSubmit ? (
          <Banner tone="warn" icon={ClockIcon}>
            <p className="font-semibold">{t('waitingStudent', { student: view.studentName })}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('waitingStudentBody')}</p>
          </Banner>
        ) : state.accepted ? (
          <Banner tone="ok" icon={CircleCheckIcon}>
            <p className="font-semibold">{t('done')}</p>
            <p className="text-[0.88rem] text-muted-foreground">
              {project.paidOrUnpaid === 'paid' ? t('donePaid') : t('doneUnpaid')}
            </p>
            {project.paidOrUnpaid === 'paid' && (
              <Button asChild size="sm" variant="secondary" className="mt-2">
                <Link href="/team/payments?filter=all">{t('toPayments')}</Link>
              </Button>
            )}
          </Banner>
        ) : null}
      </Card>

      {earlier.length > 0 && (
        <Card className="gap-4">
          <CardTitle>{t('earlierTitle')}</CardTitle>
          <div className="grid gap-5">
            {earlier.map((h) => (
              <HandInView
                key={h.id}
                handIn={h}
                audience="team"
                className="border-t border-line pt-4 first:border-t-0 first:pt-0"
              />
            ))}
          </div>
        </Card>
      )}
      <ActivityCard rows={view.activity} describe={describe} />
    </>
  )
}
