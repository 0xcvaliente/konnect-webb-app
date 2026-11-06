'use client'

import { ChevronDownIcon, CircleHelpIcon, LogOutIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useId } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

export type AccountUser = {
  /** Shown next to the avatar on wide screens and at the top of the menu. */
  name: string
  /** Second line in the menu, for example the email address or the company. */
  detail?: string
}

/**
 * Name and avatar that open the account menu: Profile, Settings, Help, Log out.
 * Log out posts to /api/auth/logout, which checks the origin and ends the session.
 */
export function AccountMenu({
  user,
  profileHref,
  settingsHref,
  helpHref,
  avatarClassName,
}: {
  user: AccountUser
  profileHref?: string
  settingsHref: string
  helpHref: string
  avatarClassName?: string
}) {
  const t = useTranslations('Shell.account')
  const logoutForm = useId()
  const initial = user.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <>
      <form id={logoutForm} method="post" action="/api/auth/logout" hidden />
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full p-1.5 font-semibold text-current transition-colors hover:bg-current/12 data-[state=open]:bg-current/12 lg:pr-3">
          <span
            aria-hidden="true"
            className={cn(
              'grid size-8 place-items-center rounded-full bg-primary text-[0.78rem] font-bold text-primary-foreground',
              avatarClassName,
            )}
          >
            {initial}
          </span>
          <span className="hidden max-w-[18ch] truncate text-[0.88rem] lg:inline">{user.name}</span>
          <span className="sr-only">{t('menu')}</span>
          <ChevronDownIcon aria-hidden="true" className="hidden size-3.5 lg:block" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[min(18rem,calc(100vw-2rem))]">
          <DropdownMenuLabel>
            <span className="truncate font-semibold">{user.name}</span>
            {user.detail && (
              <span className="truncate text-[0.85rem] font-normal text-muted-foreground">
                {user.detail}
              </span>
            )}
          </DropdownMenuLabel>
          {profileHref && (
            <DropdownMenuItem asChild>
              <Link href={profileHref} prefetch={false} className="text-foreground no-underline">
                <UserIcon aria-hidden="true" />
                {t('profile')}
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <Link href={settingsHref} prefetch={false} className="text-foreground no-underline">
              <SettingsIcon aria-hidden="true" />
              {t('settings')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={helpHref} prefetch={false} className="text-foreground no-underline">
              <CircleHelpIcon aria-hidden="true" />
              {t('help')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <button type="submit" form={logoutForm} className="w-full text-left">
              <LogOutIcon aria-hidden="true" />
              {t('logOut')}
            </button>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
