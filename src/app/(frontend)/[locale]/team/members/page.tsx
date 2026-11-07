import { MailIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { AwayForm, ClearAwayButton, ReassignForm } from '@/components/app/team/TeamForms'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { teamCounts } from '@/lib/team/counts'
import {
  coveredBy,
  firstName,
  isAwayOn,
  listTeam,
  loadTeamOverview,
  type TeamMember,
} from '@/lib/team/members'
import { requireTeam } from '@/lib/team/session'
import { isDueSoon, isOverdue, itemsOf, loadToday } from '@/lib/team/today'

export const dynamic = 'force-dynamic'

const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

/**
 * The Team page (Kanban card "Team page: workload, owners and away cover", mockup "Team
 * workload"): each team member's workload, the owner of every company, and who is away and who
 * covers. Every team member may change owners and away days for anyone; the Server Actions and
 * the collection hooks check everything again and log each change.
 */
export default async function TeamMembersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const t = await getTranslations('TeamMembers')
  const tRole = await getTranslations('Roles')
  const format = await getFormatter()

  const [team, overview, today] = await Promise.all([
    listTeam(payload, user),
    loadTeamOverview(payload, user),
    loadToday(payload, user),
  ])
  const counts = await teamCounts(payload, user, today)
  const members = team ?? []
  const day = today?.today ?? ''
  const date = (value: string) => {
    const [y, m, d] = value.split('-').map(Number)
    return format.dateTime(new Date(Date.UTC(y!, m! - 1, d!, 12)), {
      day: 'numeric',
      month: 'short',
      timeZone: 'Europe/Oslo',
    })
  }
  const nameOf = (id: number | null | undefined) =>
    members.find((m) => m.id === id)?.name ?? t('noOwner')
  const options = members.map((m) => ({ id: m.id, name: m.name }))
  const companies = overview?.companies ?? []
  const items = today?.items ?? []

  const workload = (member: TeamMember) => {
    const own = itemsOf(items, new Set([member.id]))
    return {
      active: overview?.activeByOwner.get(member.id) ?? 0,
      open: own.length,
      soon: own.filter(isDueSoon).length,
      late: own.filter(isOverdue).length,
    }
  }
  const away = members.filter((m) => m.away && m.away.until >= day)

  return (
    <TeamShell
      current="team"
      counts={counts}
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team', label: t('back') }}
      title={t('title')}
      lede={t('lede')}
    >
      <ul className="grid max-w-[1100px] gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
        {members.map((member) => {
          const numbers = workload(member)
          const owns = companies.filter((c) => c.ownerId === member.id).map((c) => c.name)
          const awayNow = isAwayOn(member, day)
          const covers = coveredBy(members, member.id, day)
          return (
            <li key={member.id}>
              <Card className="h-full gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[0.74rem] font-bold text-primary-foreground"
                    >
                      {initials(member.name)}
                    </span>
                    <h2 className="text-base font-semibold [overflow-wrap:anywhere]">
                      {member.name}
                    </h2>
                    {member.id === user.id && <Badge variant="tag">{t('you')}</Badge>}
                  </div>
                  {awayNow ? (
                    <Badge tone="warn">{t('awayNow')}</Badge>
                  ) : member.away && member.away.from > day ? (
                    <Badge tone="mute">{t('awayLater', { date: date(member.away.from) })}</Badge>
                  ) : null}
                </div>
                <dl className="grid grid-cols-2 gap-2">
                  {(['active', 'open', 'soon', 'late'] as const).map((key) => (
                    <div
                      key={key}
                      className="flex flex-col gap-0.5 rounded-item bg-surface-2 px-3 py-2.5"
                    >
                      <dt className="text-[0.82rem] text-muted-foreground">{t(`nums.${key}`)}</dt>
                      <dd
                        className={`order-first text-[1.35rem] leading-[1.1] font-semibold tabular-nums ${
                          key === 'late' && numbers.late
                            ? 'text-destructive'
                            : key === 'soon' && numbers.soon
                              ? 'text-warning'
                              : ''
                        }`}
                      >
                        {numbers[key]}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="text-[0.88rem] [overflow-wrap:anywhere] text-muted-foreground">
                  {t('owns', { count: owns.length, names: owns.join(', ') })}
                  {member.away && member.away.until >= day
                    ? ` ${t('awayText', {
                        from: date(member.away.from),
                        until: date(member.away.until),
                        cover: firstName(nameOf(member.away.coverId)),
                      })}`
                    : ''}
                  {covers.length
                    ? ` ${t('coversText', {
                        names: covers.map((c) => firstName(c.name)).join(', '),
                        until: date(covers[0]!.away!.until),
                      })}`
                    : ''}
                </p>
              </Card>
            </li>
          )
        })}
      </ul>

      <div className="grid max-w-[1100px] items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="gap-3">
          <CardTitle>{t('ownersTitle')}</CardTitle>
          <CardDescription>{t('ownersBody')}</CardDescription>
          {companies.length ? (
            <ul className="grid">
              {companies.map((company) => (
                <li
                  key={company.id}
                  className="grid gap-3 border-b border-line py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
                >
                  <div className="grid content-start gap-1">
                    <h3 className="font-semibold [overflow-wrap:anywhere]">{company.name}</h3>
                    <p className="text-[0.85rem] text-muted-foreground">
                      {t('activeProjects')}: <span className="tabular-nums">{company.active}</span>
                    </p>
                    <p className="text-[0.85rem] text-muted-foreground">
                      {t('owner')}: {nameOf(company.ownerId)}
                    </p>
                  </div>
                  <ReassignForm
                    collection="companies"
                    id={company.id}
                    ownerId={company.ownerId}
                    members={options}
                    labels={{
                      owner: t('ownerOf', { company: company.name }),
                      note: t('noteLabel'),
                      noteHint: t('noteHint'),
                      submit: t('move'),
                      pending: t('moving'),
                      done: t('moved'),
                      choose: t('noOwner'),
                    }}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.9rem] text-muted-foreground">{t('noCompanies')}</p>
          )}
        </Card>

        <div className="grid min-w-0 gap-5">
          <Card className="gap-3">
            <CardTitle>{t('awayTitle')}</CardTitle>
            <CardDescription>{t('awayBody')}</CardDescription>
            <AwayForm members={options} meId={user.id} today={day} />
            <h3 className="pt-2 text-[0.95rem] font-semibold">{t('currentAway')}</h3>
            {away.length ? (
              <ul className="grid">
                {away.map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-2 text-[0.9rem] last:border-b-0"
                  >
                    <span className="[overflow-wrap:anywhere]">
                      {t('awayRow', {
                        name: m.name,
                        from: date(m.away!.from),
                        until: date(m.away!.until),
                        cover: nameOf(m.away!.coverId),
                      })}
                    </span>
                    <ClearAwayButton memberId={m.id} label={`${t('clear')}: ${m.name}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[0.9rem] text-muted-foreground">{t('noAway')}</p>
            )}
          </Card>

          <Card className="gap-3">
            <CardTitle>{t('howTitle')}</CardTitle>
            <ul className="grid list-disc gap-2 pl-5 text-[0.92rem]">
              {(['pool', 'follow', 'cover', 'everyone'] as const).map((key) => (
                <li key={key}>{t(`how.${key}`)}</li>
              ))}
            </ul>
            <Banner icon={MailIcon}>
              <p className="font-semibold">{t('morningTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('morningBody')}</p>
            </Banner>
          </Card>
        </div>
      </div>
    </TeamShell>
  )
}
