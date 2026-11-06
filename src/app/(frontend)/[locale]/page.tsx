import config from '@payload-config'
import { CheckIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { cookies, headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { companyIdOf, isAdmin } from '@/access/roles'
import { EntryShell } from '@/components/app/EntryShell'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { AUTH_MESSAGES, isAuthErrorCode } from '@/lib/auth/messages'
import { findOwnProfile, type SessionUser } from '@/lib/students/profile'

import { EntryForms } from './EntryForms'

// Signed out: the entry page (sign in or create an account), with "You are signed out" after a
// sign-out and "You were signed out" when a session ended elsewhere. Signed in: first a notice
// about a newly added way to sign in, then the home for the user's role (the team workspace for
// the team, a placeholder for the others until the dashboards are built). No role yet: the role
// step.
export const dynamic = 'force-dynamic'

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ auth_error?: string; tab?: string; signed_out?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { auth_error, tab, signed_out } = await searchParams
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })

  if (!user) {
    // A session cookie that no longer works: the session was ended (signed out everywhere, the
    // account paused) or expired. Only says so; nothing about the account.
    const staleSession = (await cookies()).has(`${payload.config.cookiePrefix}-token`)
    const signedOut = signed_out === '1' ? 'now' : staleSession ? 'ended' : undefined
    const t = await getTranslations('Entry')
    const facts = [
      { Icon: ShieldCheckIcon, text: t('factReview') },
      { Icon: LockIcon, text: t('factPrivacy') },
      { Icon: CheckIcon, text: t('factCoordinate') },
    ]
    return (
      <EntryShell
        title={t('title')}
        lede={t('lede')}
        aside={
          <ul className="grid gap-3">
            {facts.map(({ Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-muted-foreground">
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        }
      >
        <EntryForms
          locale={locale}
          initialTab={tab === 'signup' ? 'signup' : 'signin'}
          notice={isAuthErrorCode(auth_error) ? AUTH_MESSAGES[auth_error][locale] : undefined}
          signedOut={isAuthErrorCode(auth_error) ? undefined : signedOut}
        />
      </EntryShell>
    )
  }

  // A way to sign in was added since the last visit: say so once (mockup "Signed out and linked").
  if (user.methodAddedNotice) return redirect({ href: '/sign-in/added', locale })
  if (user.role === 'pending') return redirect({ href: '/choose-role', locale })
  // The team works in the team workspace.
  if (isAdmin(user)) return redirect({ href: '/team', locale })
  // A student fills in the onboarding first, once.
  if (user.role === 'student' && !(await findOwnProfile(payload, user as SessionUser))) {
    return redirect({ href: '/student/welcome', locale })
  }
  // A company registers its company first, once; after that its home is the status page.
  if (user.role === 'company') {
    return redirect({ href: companyIdOf(user) ? '/company' : '/company/welcome', locale })
  }

  const t = await getTranslations('Home')
  const tRole = await getTranslations('Roles')

  // A team account whose address was taken off the ADMIN_EMAILS list: its access has ended.
  if (user.role === 'admin') {
    return (
      <EntryShell title={t('teamEndedTitle')} lede={t('teamEndedBody')}>
        <Card>
          <form method="post" action="/api/auth/logout">
            <Button type="submit" variant="secondary" className="w-full">
              {t('signOut')}
            </Button>
          </form>
        </Card>
      </EntryShell>
    )
  }

  const account = accountMenuUser(user, tRole(user.role))
  const card = (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>{t('signedInTitle')}</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <span className="break-all">{t('signedInAs', { email: user.email })}</span>
          <Badge tone="info">{tRole(user.role)}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground">{t('placeholder')}</p>
        <form method="post" action="/api/auth/logout">
          <Button type="submit" variant="secondary">
            {t('signOut')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )

  return (
    <SiteShell role={user.role} user={account} title={t('title')} lede={t('lede')}>
      {card}
    </SiteShell>
  )
}
