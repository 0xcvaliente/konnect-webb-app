import config from '@payload-config'
import { CheckIcon, KeyRoundIcon } from 'lucide-react'
import type { Metadata } from 'next'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { EntryShell } from '@/components/app/EntryShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { dismissMethodNoticeAction } from '@/lib/team/actions'

export const metadata: Metadata = { robots: { index: false } }
export const dynamic = 'force-dynamic'

/**
 * "A new way to sign in was added" (mockup "Signed out and linked", state "Google added"). Shown
 * once, on the next page after sign-in, when Google was linked to the account or a password was
 * set. The owner of the address also got an email. Only the signed-in person sees their own.
 */
export default async function MethodAddedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user?.methodAddedNotice) return redirect({ href: '/', locale })

  const t = await getTranslations('MethodAdded')
  const m = await getTranslations('SignInMethods')
  const added = user.methodAddedNotice
  const team = user.role === 'admin' || isAdminEmail(user.email)
  const methods = [
    ...(user.googleSub ? ['google' as const] : []),
    ...(team ? [] : ['link' as const]),
    ...(user.passwordSetAt && !team ? ['password' as const] : []),
  ]

  return (
    <EntryShell
      icon={added === 'google' ? <CheckIcon /> : <KeyRoundIcon />}
      title={added === 'google' ? t('googleTitle') : t('passwordTitle')}
      lede={
        added === 'google'
          ? t('googleLede', { email: user.email })
          : t('passwordLede', { email: user.email })
      }
    >
      <Card className="gap-4">
        <CardTitle>{t('methodsTitle')}</CardTitle>
        <ul className="grid">
          {methods.map((method) => (
            <li
              key={method}
              className="flex min-h-11 items-center gap-2.5 border-b border-line py-2 last:border-b-0"
            >
              <CheckIcon aria-hidden="true" className="size-[18px] shrink-0 text-success" />
              <span className={method === added ? 'font-semibold' : undefined}>{m(method)}</span>
              {method === added && <Badge variant="new">{t('new')}</Badge>}
            </li>
          ))}
        </ul>
        <form action={dismissMethodNoticeAction}>
          <input type="hidden" name="locale" value={locale} />
          <Button type="submit" size="lg" className="w-full">
            {t('continue')}
          </Button>
        </form>
        <p className="text-[0.88rem] text-muted-foreground">{t('note')}</p>
        <div className="flex flex-wrap items-center gap-x-2 text-[0.88rem] text-muted-foreground">
          <span>{t('notYou')}</span>
          <form method="post" action="/api/auth/logout">
            <Button type="submit" variant="text" size="sm" className="px-0">
              {t('signOut')}
            </Button>
          </form>
        </div>
      </Card>
    </EntryShell>
  )
}
