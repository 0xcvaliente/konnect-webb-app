import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { isAccountFilter, listAccounts } from '@/lib/team/accounts'
import { ACCOUNT_FILTERS, type AccountFilter } from '@/lib/team/fields'
import { requireTeam } from '@/lib/team/session'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/** Query string for a list address, keeping only what is set. */
const listHref = (q: string, filter: AccountFilter, page = 1) => {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (filter !== 'all') params.set('filter', filter)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return `/team/users${query ? `?${query}` : ''}`
}

/**
 * The team's account list: everyone who signed up, newest first, with a search on name and email
 * and a filter by role or paused. Only the team can open it; the list is read as the team member
 * with access control on. Opening a row leads to the "User account" screen.
 */
export default async function TeamUsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ q?: string; filter?: string; page?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const search = await searchParams
  const q = typeof search.q === 'string' ? search.q.trim().slice(0, 100) : ''
  const filter: AccountFilter = isAccountFilter(search.filter) ? search.filter : 'all'
  const page = Math.max(1, Number.parseInt(search.page ?? '1', 10) || 1)

  const list = await listAccounts(payload, user, { q, filter, page })
  if (!list) notFound()

  const t = await getTranslations('TeamAccounts')
  const tRole = await getTranslations('Roles')
  const tStatus = await getTranslations('AccountStatus')
  const format = await getFormatter()

  return (
    <TeamShell
      current="users"
      user={accountMenuUser(user, tRole('admin'))}
      title={t('title')}
      lede={t('lede')}
    >
      <div className="grid gap-4">
        <form role="search" method="get" className="flex max-w-[640px] flex-wrap gap-2.5">
          {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
          <div className="relative min-w-[min(100%,240px)] flex-1">
            <label htmlFor="account-search" className="sr-only">
              {t('searchLabel')}
            </label>
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="account-search"
              type="search"
              name="q"
              defaultValue={q}
              placeholder={t('searchPlaceholder')}
              autoComplete="off"
              className="pl-10"
            />
          </div>
          <Button type="submit" variant="normal">
            {t('search')}
          </Button>
        </form>

        <nav aria-label={t('filterLabel')} className="flex flex-wrap gap-2">
          {ACCOUNT_FILTERS.map((key) => (
            <Link
              key={key}
              href={listHref(q, key)}
              prefetch={false}
              aria-current={key === filter ? 'true' : undefined}
              className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-[0.88rem] font-medium text-foreground no-underline transition-colors hover:bg-surface-2 aria-[current=true]:border-transparent aria-[current=true]:bg-tint aria-[current=true]:text-tint-foreground sm:min-h-9"
            >
              {t(`filters.${key}`)}
            </Link>
          ))}
        </nav>

        <p role="status" className="text-[0.88rem] text-muted-foreground">
          {t('count', { count: list.totalDocs })}
        </p>
      </div>

      <Card className="p-0 sm:p-0">
        {list.docs.length === 0 ? (
          <div className="grid gap-1 px-4 py-8 text-center text-muted-foreground">
            <p className="font-semibold text-foreground">{t('emptyTitle')}</p>
            <p>{t('emptyBody')}</p>
          </div>
        ) : (
          <table className="w-full border-collapse text-[0.92rem]">
            <thead className="max-sm:sr-only">
              <tr className="text-left text-[0.8rem] text-muted-foreground">
                <th scope="col" className="px-5 pt-4 pb-2.5 font-medium">
                  {t('name')}
                </th>
                <th scope="col" className="px-3 pt-4 pb-2.5 font-medium">
                  {t('role')}
                </th>
                <th scope="col" className="px-3 pt-4 pb-2.5 font-medium">
                  {t('status')}
                </th>
                <th scope="col" className="px-5 pt-4 pb-2.5 text-right font-medium">
                  {t('signedUp')}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.docs.map((account) => (
                <tr
                  key={account.id}
                  className="border-t border-line max-sm:flex max-sm:first:border-t-0 max-sm:flex-wrap max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:px-4 max-sm:py-3.5"
                >
                  <td className="min-w-0 px-5 py-3.5 align-top max-sm:basis-full max-sm:p-0">
                    <Link
                      href={`/team/users/${account.id}`}
                      prefetch={false}
                      className="font-semibold [overflow-wrap:anywhere]"
                    >
                      {account.name || t('noName')}
                    </Link>
                    <span className="block text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                      {account.email}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 align-top max-sm:p-0">
                    <Badge tone={account.role === 'pending' ? 'mute' : 'info'}>
                      {tRole(account.role)}
                    </Badge>
                  </td>
                  <td className="px-3 py-3.5 align-top max-sm:p-0">
                    <Badge tone={account.accountStatus === 'paused' ? 'bad' : 'ok'}>
                      {tStatus(account.accountStatus === 'paused' ? 'paused' : 'active')}
                    </Badge>
                  </td>
                  <td className="px-5 py-3.5 text-right align-top text-muted-foreground tabular-nums max-sm:ml-auto max-sm:p-0 max-sm:text-[0.85rem]">
                    <span className="sr-only sm:hidden">{t('signedUp')}: </span>
                    {format.dateTime(new Date(account.createdAt), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {list.totalPages > 1 && (
        <nav aria-label={t('pagination')} className="flex flex-wrap items-center gap-3">
          <PageLink
            href={listHref(q, filter, list.page - 1)}
            disabled={list.page <= 1}
            label={t('previous')}
            icon={<ChevronLeftIcon aria-hidden="true" />}
          />
          <span className="text-[0.88rem] text-muted-foreground tabular-nums">
            {t('page', { page: list.page, pages: list.totalPages })}
          </span>
          <PageLink
            href={listHref(q, filter, list.page + 1)}
            disabled={list.page >= list.totalPages}
            label={t('next')}
            icon={<ChevronRightIcon aria-hidden="true" />}
            iconAfter
          />
        </nav>
      )}
    </TeamShell>
  )
}

function PageLink({
  href,
  disabled,
  label,
  icon,
  iconAfter = false,
}: {
  href: string
  disabled: boolean
  label: string
  icon: ReactNode
  iconAfter?: boolean
}) {
  if (disabled) {
    return (
      <Button variant="secondary" disabled>
        {!iconAfter && icon}
        {label}
        {iconAfter && icon}
      </Button>
    )
  }
  return (
    <Button asChild variant="secondary" className={cn(iconAfter ? 'pr-3.5' : 'pl-3.5')}>
      <Link href={href} prefetch={false}>
        {!iconAfter && icon}
        {label}
        {iconAfter && icon}
      </Link>
    </Button>
  )
}
