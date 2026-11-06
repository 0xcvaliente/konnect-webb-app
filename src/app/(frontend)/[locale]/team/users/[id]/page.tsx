import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { type ActivityItem, loadAccount } from '@/lib/team/accounts'
import { requireTeam } from '@/lib/team/session'

import { PauseCard, RoleCard, SignOutEverywhere } from './AccountActions'

export const dynamic = 'force-dynamic'

/**
 * The team's "User account" screen (mockup "User account"): who the person is, their role and how
 * they sign in, and the three team actions: fix a wrong role (only before applications or
 * projects), pause and reactivate, sign out everywhere. Admin access is never granted here.
 * Every action is checked again on the server and written to the activity log shown below.
 */
export default async function TeamUserPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user: actor } = await requireTeam(locale)
  const view = await loadAccount(payload, actor, Number(id))
  if (!view) notFound()

  const t = await getTranslations('TeamAccount')
  const tList = await getTranslations('TeamAccounts')
  const tRole = await getTranslations('Roles')
  const tWord = await getTranslations('RoleWords')
  const tStatus = await getTranslations('AccountStatus')
  const tMethod = await getTranslations('SignInMethods')
  const format = await getFormatter()

  const { user, work, hasRoleData, isTeam, methods, pauseReason, activity } = view
  const name = user.name || user.email
  const paused = user.accountStatus === 'paused'
  const day = (value: string) =>
    format.dateTime(new Date(value), { day: 'numeric', month: 'short', year: 'numeric' })
  const dayTime = (value: string) =>
    format.dateTime(new Date(value), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  const workText = isTeam
    ? t('work.admin')
    : user.role === 'pending'
      ? t('work.pending')
      : user.role === 'student'
        ? hasRoleData
          ? t('work.student', { count: work })
          : t('work.noProfile')
        : hasRoleData
          ? t('work.company', { count: work })
          : t('work.noCompany')

  const role = user.role === 'student' || user.role === 'company' ? user.role : null
  const other = role === 'student' ? 'company' : role === 'company' ? 'student' : null
  const roleState: 'team' | 'pending' | 'locked' | 'open' = isTeam
    ? 'team'
    : !other
      ? 'pending'
      : work > 0
        ? 'locked'
        : 'open'

  const actionText = (row: ActivityItem): string => {
    if (row.action === 'create') return t('actions.create')
    if (row.action === 'delete') return t('actions.delete')
    if (row.action === 'sign_out_everywhere') return t('actions.signOutEverywhere')
    if (row.action === 'sign_in_method_added') {
      return row.toStatus === 'google' ? t('actions.methodGoogle') : t('actions.methodPassword')
    }
    if (row.field === 'accountStatus') {
      return row.toStatus === 'paused' ? t('actions.paused') : t('actions.reactivated')
    }
    const word = (value: string | null | undefined) =>
      value === 'student' || value === 'company' || value === 'pending' || value === 'admin'
        ? tWord(value)
        : (value ?? '')
    if (row.fromStatus && row.toStatus) {
      return t('actions.role', { from: word(row.fromStatus), to: word(row.toStatus) })
    }
    return t('actions.other')
  }

  return (
    <TeamShell
      current="users"
      user={accountMenuUser(actor, tRole('admin'))}
      crumb={{ href: '/team/users', label: t('back') }}
      title={name}
      meta={
        <>
          <Badge tone={user.role === 'pending' ? 'mute' : 'info'}>{tRole(user.role)}</Badge>
          <Badge tone={paused ? 'bad' : 'ok'}>{tStatus(paused ? 'paused' : 'active')}</Badge>
        </>
      }
      lede={`${t('signedUp', { date: day(user.createdAt) })} ${workText}`}
    >
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-5">
          <RoleCard userId={user.id} name={name} state={roleState} to={other} />
          <PauseCard
            userId={user.id}
            name={name}
            paused={paused}
            isTeam={isTeam}
            reason={pauseReason}
          />
          <Card className="gap-3">
            <CardTitle>{t('activityTitle')}</CardTitle>
            {activity.length === 0 ? (
              <p className="text-muted-foreground">{t('activityEmpty')}</p>
            ) : (
              <ul className="grid">
                {activity.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line py-2.5 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="block">{actionText(row)}</span>
                      {row.note && (
                        <span className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                          {row.note}
                        </span>
                      )}
                      <span className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                        {row.actorName ?? t('system')}
                      </span>
                    </span>
                    <time
                      dateTime={row.createdAt}
                      className="text-[0.85rem] text-muted-foreground tabular-nums"
                    >
                      {dayTime(row.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="grid min-w-0 gap-5">
          <Card className="gap-4">
            <CardTitle>{t('signInTitle')}</CardTitle>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-2">
              <dt className="text-muted-foreground">{t('email')}</dt>
              <dd className="font-medium [overflow-wrap:anywhere]">
                {user.email}
                <span className="block text-[0.85rem] font-normal text-muted-foreground">
                  {user.emailVerifiedAt ? t('verified') : t('notVerified')}
                </span>
              </dd>
              <dt className="text-muted-foreground">{t('methods')}</dt>
              <dd className="font-medium">{methods.map((m) => tMethod(m)).join(', ')}</dd>
              <dt className="text-muted-foreground">{t('lastSignIn')}</dt>
              <dd className="font-medium tabular-nums">
                {user.lastSignInAt ? dayTime(user.lastSignInAt) : t('never')}
              </dd>
              <dt className="text-muted-foreground">{tList('signedUp')}</dt>
              <dd className="font-medium tabular-nums">{day(user.createdAt)}</dd>
            </dl>
            <SignOutEverywhere userId={user.id} name={name} self={actor.id === user.id} />
            <p className="text-[0.85rem] text-muted-foreground">{t('recovery')}</p>
          </Card>
        </aside>
      </div>
    </TeamShell>
  )
}
