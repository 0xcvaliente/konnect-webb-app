import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { Banner } from '@/components/app/Banner'
import { SiteShell } from '@/components/app/SiteShell'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'
import { EMPTY_INPUT } from '@/lib/projects/fields'

import { ProjectForm } from '../ProjectForm'

// "Submit a project" ("Final pass" mockup). The first save creates a draft only this company can
// see; the form then keeps saving it. A pending company writes drafts and sends after approval.
export const dynamic = 'force-dynamic'

export default async function NewProjectPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const t = await getTranslations('ProjectForm')
  const logoUrl = typeof company.logo === 'object' ? company.logo?.url : null

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="submit"
      title={t('newTitle')}
      lede={t('lede')}
    >
      {company.status === 'rejected' ? (
        <Card>
          <Banner tone="bad">
            <p className="font-semibold">{t('rejectedTitle')}</p>
            <p className="text-[0.88rem] text-muted-foreground">{t('rejectedBody')}</p>
          </Banner>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="secondary">
              <Link href="/company">{t('toStatus')}</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <ProjectForm
          initial={EMPTY_INPUT}
          files={[]}
          canSend={company.status === 'approved'}
          companyName={company.name}
          companyLogoUrl={logoUrl}
        />
      )}
    </SiteShell>
  )
}
