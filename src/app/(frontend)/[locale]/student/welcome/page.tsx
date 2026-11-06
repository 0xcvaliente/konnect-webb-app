import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { findOwnProfile, type SessionUser } from '@/lib/students/profile'

import { StudentOnboarding } from './StudentOnboarding'

// The student onboarding, right after choosing "student". Only a signed-in student without a
// profile sees it; everyone else is sent on. The Server Action checks all of this again.
export const dynamic = 'force-dynamic'

export default async function WelcomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'student') return redirect({ href: '/', locale })
  if (await findOwnProfile(payload, user as SessionUser)) {
    return redirect({ href: '/student/profile', locale })
  }
  return <StudentOnboarding locale={locale} />
}
