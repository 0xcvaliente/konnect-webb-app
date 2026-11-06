import { ArrowRightIcon, ExternalLinkIcon, ShieldCheckIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { requireTeam } from '@/lib/team/session'

export const dynamic = 'force-dynamic'

/**
 * The team workspace home ("Today"). Signed-in team members land here. The queues come with
 * their own cards; for now it carries the 2-step verification notice and the way to the accounts.
 *
 * 2-step verification: team members sign in with Google only, and Google enforces 2-step
 * verification (through Google Workspace policy or the person's own Google account). The ID
 * token does not say reliably whether it was used (`amr` is not part of Google's documented
 * claims), so Konnected does not check it and only reminds the team here.
 */
export default async function TeamHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user } = await requireTeam(locale)
  const t = await getTranslations('TeamHome')
  const tRole = await getTranslations('Roles')

  return (
    <TeamShell
      current="today"
      user={accountMenuUser(user, tRole('admin'))}
      title={t('title')}
      lede={t('lede')}
    >
      <Banner icon={ShieldCheckIcon} className="max-w-[880px]">
        <p className="font-semibold">{t('twoStepTitle')}</p>
        <p className="text-[0.88rem] text-muted-foreground">{t('twoStepBody')}</p>
        <a
          href="https://myaccount.google.com/security"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex min-h-11 items-center gap-1.5 font-semibold sm:min-h-0"
        >
          {t('twoStepLink')}
          <ExternalLinkIcon aria-hidden="true" className="size-4" />
        </a>
      </Banner>

      <div className="grid max-w-[880px] gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('accountsTitle')}</CardTitle>
            <CardDescription>{t('accountsBody')}</CardDescription>
          </CardHeader>
          <div>
            <Button asChild variant="normal">
              <Link href="/team/users">
                {t('accountsLink')}
                <ArrowRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t('panelTitle')}</CardTitle>
            <CardDescription>{t('panelBody')}</CardDescription>
          </CardHeader>
          <div>
            <Button asChild variant="secondary">
              {/* Payload's own panel has its own root layout: a full navigation, not next-intl's. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- separate app */}
              <a href="/admin">{t('panelLink')}</a>
            </Button>
          </div>
        </Card>
      </div>
    </TeamShell>
  )
}
