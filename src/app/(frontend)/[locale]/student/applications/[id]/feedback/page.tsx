import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { FeedbackBody } from '@/components/app/feedback/FeedbackPage'
import { SiteShell } from '@/components/app/SiteShell'
import { routing } from '@/i18n/routing'
import { findOwnApplication } from '@/lib/applications/student'
import { feedbackStatus } from '@/lib/feedback/feedback'
import { requireStudent } from '@/lib/students/session'

// "How did it go?" for the student ("Final pass" mockup, "Feedback after a project"): once the
// project Konnected selected them for closed after delivery. Read as the student with access
// control on; another student's application is "not found". Only Konnected reads the answers.
export const dynamic = 'force-dynamic'

export default async function StudentFeedbackPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const application = /^\d{1,10}$/.test(id)
    ? await findOwnApplication(payload, user, Number(id))
    : null
  if (!application || !application.projectId) notFound()
  const status =
    application.status === 'selected'
      ? await feedbackStatus(payload, user, application.projectId)
      : 'none'
  const t = await getTranslations('Feedback')
  const backHref = `/student/applications/${application.id}`

  return (
    <SiteShell
      role="student"
      current="applications"
      user={account}
      crumb={{ href: backHref, label: t('backStudent') }}
      title={t('title')}
      lede={t('ledeStudent', { title: application.title, company: application.companyName })}
    >
      <FeedbackBody
        status={status}
        as="student"
        projectId={application.projectId}
        backHref={backHref}
      />
    </SiteShell>
  )
}
