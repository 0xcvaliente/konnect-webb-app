import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'

import { Link } from '@/i18n/navigation'

import { LanguageSwitch } from './LanguageSwitch'
import { Brand } from './LogoMark'

/**
 * Layout for the pages before sign-in: the entry page, sign-in links, confirming an email,
 * resetting a password, choosing a role ("Final pass" mockups, the `pub-in` screens). No menu.
 * On phones one column; from 768 px the text on the left and the card on the right.
 */
export async function EntryShell({
  title,
  lede,
  icon,
  aside,
  children,
}: {
  title: ReactNode
  lede?: ReactNode
  /** A round tinted icon above the title, for status pages ("Check your email"). */
  icon?: ReactNode
  /** More content under the lede, for example the three facts on the entry page. */
  aside?: ReactNode
  children: ReactNode
}) {
  const t = await getTranslations('Shell')
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <a
        href="#main"
        className="sr-only z-50 rounded-full bg-primary px-4 py-2 font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t('skipToContent')}
      </a>
      <main
        id="main"
        className="mx-auto grid w-full max-w-[980px] flex-1 content-center gap-[22px] px-4 pt-5 pb-10 sm:px-7 sm:pt-8 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] md:gap-12"
      >
        <section className="grid min-w-0 content-center gap-4">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center rounded-full text-foreground no-underline [&>span>span]:text-[1.32rem]"
            >
              <Brand />
            </Link>
            <LanguageSwitch className="text-muted-foreground" />
          </div>
          {icon && (
            <span
              aria-hidden="true"
              className="grid size-[60px] place-items-center rounded-full bg-tint text-tint-foreground [&_svg]:size-7"
            >
              {icon}
            </span>
          )}
          <h1 className="text-[1.6rem] leading-[1.2] text-foreground sm:text-[1.92rem]">{title}</h1>
          {lede && (
            <p className="max-w-[62ch] [overflow-wrap:anywhere] text-muted-foreground">{lede}</p>
          )}
          {aside}
        </section>
        <div className="grid min-w-0 content-center">{children}</div>
      </main>
    </div>
  )
}
