import { ChevronLeftIcon, LockIcon } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

import { AccountMenu, type AccountUser } from './AccountMenu'
import { Brand } from './LogoMark'
import { LanguageSwitch } from './LanguageSwitch'
import { PROFILE_HREF, SITE_NAV, type SiteNavKey, type SiteRole } from './nav'

/**
 * Layout for students and startups (konnected-design-system, Layouts): a top bar on the mint band
 * with the menu in a centred glass pill, then the page title in the same band with 36 px rounded
 * lower corners. The first card overlaps the band by 64 px. Content is at most 1044 px wide.
 * Below 768 px the menu floats in a pill at the bottom of the screen.
 */
export async function SiteShell({
  role,
  current,
  locked = [],
  user,
  title,
  lede,
  crumb,
  actions,
  overlap = true,
  children,
}: {
  /** Shows that role's menu. Leave out for pages before a role is chosen. */
  role?: SiteRole
  current?: SiteNavKey
  /**
   * Menu items that are shown but do not open yet, for example a company's projects before
   * Konnected approves it. Shown dimmed with a lock; the pages refuse them on the server too.
   */
  locked?: readonly SiteNavKey[]
  /** The signed-in user, for the account menu. Leave out when nobody is signed in. */
  user?: AccountUser | null
  title: ReactNode
  lede?: ReactNode
  /** A link back to the list the page belongs to, above the title. */
  crumb?: { href: string; label: string }
  /** Buttons next to the title, on the band. Use the "band" button variant for the main one. */
  actions?: ReactNode
  /** Pull the first block of the page up over the band. Turn off when it is not a card. */
  overlap?: boolean
  children: ReactNode
}) {
  const t = await getTranslations('Shell')
  const nav = role ? SITE_NAV[role] : null

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('skipToContent')}
      </a>

      <header className="top-0 z-30 bg-band text-band-foreground md:sticky">
        <div className="flex items-center gap-3 px-4 py-2.5 sm:px-7 md:grid md:grid-cols-[1fr_auto_1fr]">
          <Link
            href="/"
            className="mr-auto inline-flex min-h-11 items-center rounded-full text-band-foreground no-underline md:justify-self-start"
          >
            <Brand />
          </Link>

          {nav && (
            <nav
              aria-label={t('mainMenu')}
              className={cn(
                // Phones: a floating pill at the bottom of the screen.
                'fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] z-40 flex justify-between gap-0.5 rounded-full p-1',
                // From 768 px: centred in the top bar.
                'md:static md:col-start-2 md:justify-center',
                // Glass, solid when the user asks for less transparency.
                'border border-glass-edge bg-glass shadow-[inset_0_1px_0_var(--glass-hi),0_12px_32px_-16px_color-mix(in_srgb,var(--ink)_38%,transparent)] backdrop-blur-[24px] backdrop-saturate-[1.8] reduce-transparency:bg-surface reduce-transparency:backdrop-blur-none reduce-transparency:backdrop-saturate-100',
              )}
            >
              {nav.map((item) => {
                const label = t(`nav.${role}.${item.key}`)
                const className =
                  'inline-flex min-h-12 flex-1 items-center justify-center gap-1 rounded-full px-1.5 text-center text-[0.78rem] leading-tight font-semibold text-muted-foreground no-underline transition-colors md:min-h-10 md:flex-none md:px-4 md:text-body md:whitespace-nowrap'
                if (locked.includes(item.key)) {
                  return (
                    <span
                      key={item.key}
                      aria-disabled="true"
                      className={cn(className, 'cursor-default opacity-60')}
                    >
                      <LockIcon aria-hidden="true" className="size-3.5 shrink-0 max-md:hidden" />
                      <span aria-hidden="true">{label}</span>
                      <span className="sr-only">{t('nav.lockedItem', { label })}</span>
                    </span>
                  )
                }
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    prefetch={false}
                    aria-current={item.key === current ? 'page' : undefined}
                    className={cn(
                      className,
                      'hover:text-foreground aria-[current=page]:bg-tint aria-[current=page]:text-tint-foreground',
                    )}
                  >
                    {label}
                  </Link>
                )
              })}
            </nav>
          )}

          <div className="flex items-center gap-1.5 md:col-start-3 md:justify-self-end">
            <LanguageSwitch className="text-band-muted" />
            {user && (
              <AccountMenu
                user={user}
                profileHref={role ? PROFILE_HREF[role] : undefined}
                settingsHref="/settings"
                helpHref="/help"
                avatarClassName="bg-band-link"
              />
            )}
          </div>
        </div>
      </header>

      <div
        className={cn(
          'rounded-b-[36px] bg-band px-4 pt-3 text-band-foreground sm:px-7',
          overlap ? 'pb-[76px]' : 'pb-[34px]',
        )}
      >
        <div className="mx-auto flex max-w-[1044px] flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="grid min-w-0 gap-1.5">
            {crumb && (
              <Link
                href={crumb.href}
                className="inline-flex min-h-11 w-fit items-center gap-1 text-[0.88rem] font-semibold text-band-link sm:min-h-8"
              >
                <ChevronLeftIcon aria-hidden="true" className="size-4" />
                {crumb.label}
              </Link>
            )}
            <h1 className="text-[1.6rem] leading-[1.2] text-band-foreground sm:text-[1.9rem]">
              {title}
            </h1>
            {lede && (
              <p className="max-w-[62ch] [overflow-wrap:anywhere] text-band-muted">{lede}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
        </div>
      </div>

      <main
        id="main"
        className={cn(
          'relative flex-1 px-4 pt-6 sm:px-7',
          overlap && '-mt-16 pt-0',
          nav ? 'pb-28 md:pb-12' : 'pb-12',
        )}
      >
        <div className="mx-auto grid max-w-[1044px] gap-6 sm:gap-[26px]">{children}</div>
      </main>
    </div>
  )
}
