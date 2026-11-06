import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { companyIdOf } from '@/access/roles'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'

import { CompanyOnboarding } from './CompanyOnboarding'

// The company onboarding, right after choosing "company". Only a signed-in company user without
// a company sees it; everyone else is sent on. The Server Action checks all of this again.
export const dynamic = 'force-dynamic'

export default async function CompanyWelcomePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'company') return redirect({ href: '/', locale })
  if (companyIdOf(user)) return redirect({ href: '/company', locale })
  return <CompanyOnboarding />
}
