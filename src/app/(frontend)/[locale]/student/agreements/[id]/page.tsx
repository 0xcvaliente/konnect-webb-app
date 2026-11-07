import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { PartyAgreement } from '@/components/app/agreements/PartyAgreement'
import { SiteShell } from '@/components/app/SiteShell'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { loadAgreementView } from '@/lib/agreements/views'
import type { User } from '@/payload-types'

// One student agreement: read the PDF, then sign (mockup "Agreement" for students). Read as the
// student with access control on; anything else is "not found".
export const dynamic = 'force-dynamic'

export default async function StudentAgreementPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'student') return redirect({ href: '/', locale })
  const view = await loadAgreementView(
    payload,
    { ...(user as User), collection: 'users' },
    Number(id),
  )
  if (!view || view.agreement.kind !== 'student') notFound()
  const t = await getTranslations('AgreementSign')

  return (
    <SiteShell
      role="student"
      user={accountMenuUser(user as User)}
      title={t('title')}
      lede={view.agreement.title}
      overlap={false}
    >
      <PartyAgreement view={view} role="student" />
    </SiteShell>
  )
}
