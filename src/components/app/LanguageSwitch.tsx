'use client'

import { useLocale, useTranslations } from 'next-intl'

import { Link, usePathname } from '@/i18n/navigation'
import { htmlLang, routing } from '@/i18n/routing'
import { cn } from '@/lib/utils'

/** EN / NO switch. Keeps the current page and swaps only the language prefix. */
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations('Shell')
  const locale = useLocale()
  const pathname = usePathname()

  return (
    <nav
      aria-label={t('language')}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-current/35 p-0.5',
        className,
      )}
    >
      {routing.locales.map((l) => (
        <Link
          key={l}
          href={pathname}
          locale={l}
          hrefLang={htmlLang(l)}
          lang={htmlLang(l)}
          aria-current={l === locale ? 'true' : undefined}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full px-2 text-[0.78rem] font-semibold text-current no-underline opacity-80 hover:opacity-100 aria-[current=true]:bg-current/20 aria-[current=true]:opacity-100 sm:min-h-8 sm:min-w-9"
        >
          <span aria-hidden="true">{l.toUpperCase()}</span>
          <span className="sr-only">{t(`languageName.${l}`)}</span>
        </Link>
      ))}
    </nav>
  )
}
