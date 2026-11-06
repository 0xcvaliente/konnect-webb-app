import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { Banner } from '@/components/app/Banner'
import { SiteShell } from '@/components/app/SiteShell'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { AUTH_MESSAGES, isAuthErrorCode } from '@/lib/auth/messages'

// Placeholder home page until the entry page card. It shows the sign-in state so the flow can be
// tried end to end, in the right layout for the user's role.
export const dynamic = 'force-dynamic'

export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ auth_error?: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const t = await getTranslations('Home')
  const tRole = await getTranslations('Roles')
  const { auth_error } = await searchParams
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  const account = user ? { name: user.email, detail: tRole(user.role) } : null

  const card = (
    <Card className="w-full max-w-xl">
      {isAuthErrorCode(auth_error) && (
        <Banner tone="bad" role="alert">
          {AUTH_MESSAGES[auth_error][locale]}
        </Banner>
      )}
      {user ? (
        <>
          <CardHeader>
            <CardTitle>{t('signedInTitle')}</CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              <span className="break-all">{t('signedInAs', { email: user.email })}</span>
              <Badge tone={user.role === 'pending' ? 'warn' : 'info'}>{tRole(user.role)}</Badge>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{t('placeholder')}</p>
            <div className="flex flex-wrap gap-2.5">
              {user.role === 'pending' && (
                <Button asChild>
                  <Link href="/choose-role">{t('chooseRole')}</Link>
                </Button>
              )}
              <form method="post" action="/api/auth/logout">
                <Button type="submit" variant="secondary">
                  {t('signOut')}
                </Button>
              </form>
            </div>
          </CardContent>
        </>
      ) : (
        <>
          <CardHeader>
            <CardTitle>{t('signInTitle')}</CardTitle>
            <CardDescription>{t('signInBody')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full sm:w-fit">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, needs a full navigation */}
              <a href="/api/auth/google/start">{t('continueWithGoogle')}</a>
            </Button>
          </CardContent>
        </>
      )}
    </Card>
  )

  if (user?.role === 'admin') {
    return (
      <TeamShell user={account} title={t('title')} lede={t('lede')}>
        {card}
      </TeamShell>
    )
  }

  const role = user?.role === 'student' || user?.role === 'company' ? user.role : undefined
  return (
    <SiteShell role={role} user={account} title={t('title')} lede={t('lede')}>
      {card}
    </SiteShell>
  )
}
