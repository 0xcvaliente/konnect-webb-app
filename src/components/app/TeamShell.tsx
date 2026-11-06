import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Link } from '@/i18n/navigation'

import { AccountMenu, type AccountUser } from './AccountMenu'
import { Brand } from './LogoMark'
import { LanguageSwitch } from './LanguageSwitch'
import { TEAM_NAV, type TeamNavKey } from './nav'

/**
 * Layout for the Konnected team (konnected-design-system, Layouts): a slim top bar, then a 224 px
 * menu down the left with groups and a count of open items per entry, the current one in tint.
 * Page titles sit on the ground. Below 900 px the menu becomes a row that scrolls sideways.
 */
export async function TeamShell({
  current,
  counts = {},
  user,
  title,
  lede,
  actions,
  children,
}: {
  current?: TeamNavKey
  /** Open items per menu entry. Entries without a number show no count. */
  counts?: Partial<Record<TeamNavKey, number>>
  user?: AccountUser | null
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const t = await getTranslations('Shell')

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('skipToContent')}
      </a>

      <header className="flex items-center justify-between gap-3 border-b border-line bg-background px-4 py-1.5 sm:px-5">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-full text-foreground no-underline"
        >
          <Brand />
        </Link>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <LanguageSwitch />
          {user && (
            <span className="text-foreground">
              <AccountMenu user={user} settingsHref="/settings" helpHref="/help" />
            </span>
          )}
        </div>
      </header>

      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] team:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="min-w-0 border-b border-line bg-surface team:border-r team:border-b-0">
          <nav
            aria-label={t('teamMenu')}
            className="relative flex gap-1 overflow-x-auto px-4 py-2 team:sticky team:top-0 team:max-h-dvh team:flex-col team:gap-0.5 team:overflow-y-auto team:px-3 team:pt-[18px] team:pb-7"
          >
            {TEAM_NAV.map(({ group, items }) => (
              <div key={group} className="contents team:mb-3 team:flex team:flex-col team:gap-0.5">
                <p className="hidden px-3 pb-1 text-[0.74rem] font-semibold text-muted-foreground team:block">
                  {t(`team.groups.${group}`)}
                </p>
                {items.map((item) => {
                  const count = counts[item.key]
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      prefetch={false}
                      aria-current={item.key === current ? 'page' : undefined}
                      className="group/item relative flex min-h-11 flex-none items-center justify-between gap-2.5 rounded-[10px] px-3 text-[0.88rem] font-semibold whitespace-nowrap text-muted-foreground no-underline transition-colors hover:bg-surface-2 hover:text-foreground aria-[current=page]:bg-tint aria-[current=page]:text-tint-foreground team:min-h-10"
                    >
                      <span>{t(`team.items.${item.key}`)}</span>
                      {count !== undefined && (
                        <span className="min-w-6 rounded-full bg-surface-2 px-[7px] text-center text-[0.74rem] leading-[22px] text-foreground tabular-nums group-aria-[current=page]/item:bg-surface">
                          {count}
                          <span className="sr-only"> {t('team.open')}</span>
                        </span>
                      )}
                    </Link>
                  )
                })}
              </div>
            ))}
          </nav>
        </aside>

        <main
          id="main"
          className="grid min-w-0 content-start gap-5 px-4 pt-4 pb-10 sm:px-6 sm:pt-[22px]"
        >
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="grid min-w-0 gap-1">
              <h1 className="text-[1.55rem] leading-[1.2]">{title}</h1>
              {lede && (
                <p className="max-w-[62ch] [overflow-wrap:anywhere] text-muted-foreground">
                  {lede}
                </p>
              )}
            </div>
            {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  )
}
