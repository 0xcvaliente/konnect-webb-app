import { CircleCheckIcon, ClockIcon, ExternalLinkIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { otherSide } from '@/lib/questions/fields'
import {
  listQuestionQueue,
  listRecentlyAnswered,
  listSavedAnswers,
  loadTeamQuestion,
  type QuestionItem,
  type SavedAnswerView,
  type TeamQuestion,
} from '@/lib/questions/team'
import { teamCounts } from '@/lib/team/counts'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'

import { DueChip, OwnerChip, waitedText } from '../approvals/QueueParts'
import { AnswerForm, RelayForm, RemoveSavedAnswer, SavedAnswerForm } from './QuestionForms'

export const dynamic = 'force-dynamic'

/** The screen's address, keeping only what is set. */
const questionsHref = (mine: boolean, item?: number) => {
  const params = new URLSearchParams()
  if (mine) params.set('who', 'mine')
  if (item) params.set('item', String(item))
  const query = params.toString()
  return `/team/questions${query ? `?${query}` : ''}`
}

async function moment(iso: string) {
  const format = await getFormatter()
  return format.dateTime(new Date(iso), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Oslo',
  })
}

async function dayText(iso: string) {
  const format = await getFormatter()
  return format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' })
}

/**
 * Questions ("Konnected team daily work" mockup, Questions): Ask Konnected questions from students
 * and companies about their projects. Each lands with the project's owner on the team (or the
 * shared pool) with a countdown to the 2 working days Konnected promises. The team answers (the
 * asker gets it by email and in the app), passes a question on to the other side in its own words
 * when it needs their input, and keeps saved answers for questions that come back.
 *
 * Only the asker and the team read a question: the collection's read rule makes sure of it,
 * whatever this page does. Every answer is checked again on the server and logged.
 */
export default async function TeamQuestionsPage({
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

  const t = await getTranslations('TeamQuestions')
  const tRole = await getTranslations('Roles')
  const [queue, counts, answered, saved] = await Promise.all([
    listQuestionQueue(payload, user, { mine }),
    teamCounts(payload, user),
    listRecentlyAnswered(payload, user),
    listSavedAnswers(payload, user),
  ])
  const items = queue ?? []
  const selectedId = asked ?? items[0]?.id ?? null
  const view = selectedId ? await loadTeamQuestion(payload, user, selectedId) : null

  return (
    <TeamShell
      current="questions"
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
              href={questionsHref(value)}
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
            <Detail
              view={view}
              saved={saved}
              nextHref={(() => {
                const next = items.find((i) => i.id !== view.id)
                return next ? `${questionsHref(mine, next.id)}#item` : null
              })()}
            />
          ) : (
            <Card className="gap-3">
              <CardTitle>{t('emptyTitle')}</CardTitle>
              <p className="text-muted-foreground">{t('emptyBody')}</p>
            </Card>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-2">
        <Card className="gap-3">
          <CardTitle>{t('answeredTitle')}</CardTitle>
          {answered.length === 0 ? (
            <p className="text-muted-foreground">{t('answeredEmpty')}</p>
          ) : (
            <ul className="grid">
              {await Promise.all(
                answered.map(async (a) => (
                  <li
                    key={a.id}
                    className="grid gap-0.5 border-b border-line py-2.5 first:pt-0 last:border-b-0 last:pb-0"
                  >
                    <p className="[overflow-wrap:anywhere]">
                      <b className="font-semibold">{a.asker}</b>
                      <span className="text-muted-foreground"> · {a.title}</span>
                    </p>
                    <p className="line-clamp-2 text-[0.9rem] [overflow-wrap:anywhere]">{a.body}</p>
                    <p className="line-clamp-2 text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                      {a.answer}
                    </p>
                    <p className="text-[0.8rem] text-muted-foreground">
                      {t('answeredBy', {
                        name: a.answeredByName ?? t('team'),
                        date: await dayText(a.answeredAt),
                      })}
                    </p>
                  </li>
                )),
              )}
            </ul>
          )}
        </Card>
        <SavedAnswers saved={saved} />
      </div>
    </TeamShell>
  )
}

async function QueueList({
  items,
  selectedId,
  mine,
}: {
  items: QuestionItem[]
  selectedId: number | null
  mine: boolean
}) {
  const t = await getTranslations('TeamQuestions')
  if (!items.length) {
    return (
      <p className="rounded-item border-[1.5px] border-dashed border-line p-4 text-[0.88rem] text-muted-foreground">
        {mine ? t('queueEmptyMine') : t('queueEmpty')}
      </p>
    )
  }
  return (
    <section aria-labelledby="q-open" className="grid content-start gap-2">
      <h2 id="q-open" className="px-0.5 text-[0.82rem] font-semibold text-muted-foreground">
        {t('queueTitle')} <span className="tabular-nums">({items.length})</span>
      </h2>
      <ul className="grid gap-2">
        {await Promise.all(
          items.map(async (item) => {
            const selected = item.id === selectedId
            return (
              <li key={item.id}>
                <Link
                  href={`${questionsHref(mine, item.id)}#item`}
                  prefetch={false}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'grid min-h-11 gap-1 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3 text-foreground no-underline transition-colors hover:bg-surface-2',
                    selected && 'border-transparent bg-tint hover:bg-tint',
                  )}
                >
                  <b className="font-semibold [overflow-wrap:anywhere]">{item.asker}</b>
                  <small className="text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground">
                    {t('itemSub', {
                      side: t(`side.${item.side}`),
                      title: item.title,
                      waited: await waitedText(item.since),
                    })}
                  </small>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <OwnerChip owner={item.owner} />
                    <DueChip due={item.due} />
                  </span>
                </Link>
              </li>
            )
          }),
        )}
      </ul>
    </section>
  )
}

async function Detail({
  view,
  saved,
  nextHref,
}: {
  view: TeamQuestion
  saved: SavedAnswerView[]
  nextHref: string | null
}) {
  const t = await getTranslations('TeamQuestions')
  const to = otherSide(view.side)
  return (
    <>
      <Card className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{view.asker}</h2>
            <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {t('asked', {
                side: t(`side.${view.side}`),
                title: view.title,
                date: await moment(view.since),
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <OwnerChip owner={view.owner} />
            {view.status === 'open' ? (
              <DueChip due={view.due} />
            ) : (
              <Badge tone="ok">{t('answeredPill')}</Badge>
            )}
          </div>
        </div>
        <blockquote className="border-l-[3px] border-line py-0.5 pl-3.5 [overflow-wrap:anywhere] whitespace-pre-line">
          {view.body}
        </blockquote>

        {view.status === 'open' ? (
          <div className="border-t border-line pt-4">
            <AnswerForm questionId={view.id} asker={view.asker} side={view.side} saved={saved} />
          </div>
        ) : (
          <Banner tone="ok" icon={CircleCheckIcon}>
            <div className="grid gap-1">
              <p className="font-semibold">
                {t('answeredOn', {
                  name: view.answeredByName ?? t('team'),
                  date: await moment(view.answeredAt ?? view.since),
                })}
              </p>
              <p className="text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line">
                {view.answer}
              </p>
            </div>
          </Banner>
        )}

        <div className="flex flex-wrap gap-2.5 border-t border-line pt-4">
          <Button asChild size="sm" variant="secondary">
            <Link href={`/team/projects/${view.projectId}`} prefetch={false}>
              <ExternalLinkIcon aria-hidden="true" className="size-4" />
              {t('openProject')}
            </Link>
          </Button>
          {nextHref && (
            <Button asChild size="sm" variant="text">
              <Link href={nextHref} prefetch={false}>
                {t('next')}
              </Link>
            </Button>
          )}
        </div>
      </Card>

      <Card className="gap-3">
        <div className="grid gap-1">
          <CardTitle>{t(`relayTitle.${to}`)}</CardTitle>
          <p className="text-[0.88rem] text-muted-foreground">{t('relayBody')}</p>
        </div>
        {view.relays.length > 0 && (
          <ul className="grid gap-2">
            {await Promise.all(
              view.relays.map(async (r) => (
                <li key={r.id} className="grid gap-1.5 rounded-item bg-surface-2 px-3.5 py-3">
                  <p className="text-[0.82rem] text-muted-foreground">
                    {t('relayedOn', { date: await moment(r.createdAt) })}
                  </p>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-line">{r.body}</p>
                  {r.answer ? (
                    <div className="grid gap-0.5 border-l-[3px] border-line pl-3">
                      <p className="text-[0.82rem] text-muted-foreground">
                        {t(`relayAnswered.${r.side}`, { date: await moment(r.answeredAt!) })}
                      </p>
                      <p className="text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line">
                        {r.answer}
                      </p>
                    </div>
                  ) : (
                    <p className="inline-flex items-center gap-1.5 text-[0.85rem] text-muted-foreground">
                      <ClockIcon aria-hidden="true" className="size-4" />
                      {t('relayWaiting')}
                    </p>
                  )}
                </li>
              )),
            )}
          </ul>
        )}
        {view.status !== 'open' ? null : view.canRelay ? (
          <RelayForm questionId={view.id} to={to} />
        ) : (
          <p className="text-[0.88rem] text-muted-foreground">{t('relayNone')}</p>
        )}
      </Card>
    </>
  )
}

async function SavedAnswers({ saved }: { saved: SavedAnswerView[] }) {
  const t = await getTranslations('TeamQuestions')
  return (
    <Card className="gap-4">
      <div className="grid gap-1">
        <CardTitle>{t('savedTitle')}</CardTitle>
        <p className="text-[0.88rem] text-muted-foreground">{t('savedBody')}</p>
      </div>
      {saved.length === 0 ? (
        <p className="text-muted-foreground">{t('savedEmpty')}</p>
      ) : (
        <ul className="grid">
          {saved.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line py-2.5 first:pt-0 last:border-b-0"
            >
              <div className="min-w-0 flex-1 basis-56">
                <b className="block font-semibold [overflow-wrap:anywhere]">{s.title}</b>
                <p className="line-clamp-2 text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                  {s.body}
                </p>
              </div>
              <RemoveSavedAnswer id={s.id} title={s.title} />
            </li>
          ))}
        </ul>
      )}
      <details className="group border-t border-line pt-3">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-primary sm:min-h-9">
          {t('savedNew')}
        </summary>
        <div className="pt-2">
          <SavedAnswerForm />
        </div>
      </details>
    </Card>
  )
}
