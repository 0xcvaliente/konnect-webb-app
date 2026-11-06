import config from '@payload-config'
import { CircleCheckIcon, ClockIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { Banner } from '@/components/app/Banner'
import type { CvInfo } from '@/components/app/CvField'
import { SiteShell } from '@/components/app/SiteShell'
import { accountMenuUser } from '@/lib/account'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { SHARE_KEYS, type ShareKey } from '@/lib/students/fields'
import { findOwnProfile, type SessionUser } from '@/lib/students/profile'
import type { Cv } from '@/payload-types'

import { ProfileForms, type ProfileValues } from './ProfileForms'

// The student's profile: everything from the onboarding, plus experience and contact details, the
// CV, what a company may see after selection, and where Konnected's review stands. Read as the
// student with access control on; the Server Actions check the session again.
export const dynamic = 'force-dynamic'

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'student') return redirect({ href: '/', locale })

  const profile = await findOwnProfile(payload, user as SessionUser, 1)
  if (!profile) return redirect({ href: '/student/welcome', locale })

  const t = await getTranslations('Profile')
  const format = await getFormatter()

  const cvDoc = typeof profile.cv === 'object' && profile.cv ? (profile.cv as Cv) : null
  const cv: CvInfo | null = cvDoc
    ? {
        id: cvDoc.id,
        name: cvDoc.originalName ?? cvDoc.filename ?? 'CV.pdf',
        size: cvDoc.filesize,
        uploadedAt: cvDoc.createdAt,
        url: cvDoc.url,
      }
    : null

  const values: ProfileValues = {
    name: profile.name,
    school: profile.school ?? '',
    programme: profile.programme ?? '',
    year: profile.year ? String(profile.year) : '',
    pitch: profile.pitch ?? '',
    skills: (profile.skills ?? []).join(', '),
    interests: profile.interests ?? [],
    preferredProjectTypes: profile.preferredProjectTypes ?? [],
    experience: profile.experience ?? '',
    highlights: profile.highlights ?? '',
    contactEmail: profile.contactEmail ?? '',
    phone: profile.phone ?? '',
  }
  const privacy = Object.fromEntries(
    SHARE_KEYS.map((key) => [key, profile.privacy?.[key] === true]),
  ) as Record<ShareKey, boolean>

  const reviewed = profile.reviewStatus === 'reviewed' && profile.reviewedAt

  return (
    <SiteShell
      role="student"
      user={accountMenuUser({ name: user.name || profile.name, email: user.email })}
      title={t('title')}
      lede={t('lede')}
      overlap={false}
    >
      {reviewed ? (
        <Banner tone="ok" icon={CircleCheckIcon}>
          <p className="font-semibold">{t('reviewedTitle')}</p>
          <p className="text-[0.88rem] text-muted-foreground">
            {t('reviewedBody', {
              date: format.dateTime(new Date(profile.reviewedAt!), { dateStyle: 'long' }),
            })}
          </p>
        </Banner>
      ) : (
        <Banner tone="warn" icon={ClockIcon}>
          <p className="font-semibold">{t('waitingTitle')}</p>
          <p className="text-[0.88rem] text-muted-foreground">{t('waitingBody')}</p>
        </Banner>
      )}
      <ProfileForms values={values} cv={cv} privacy={privacy} />
    </SiteShell>
  )
}
