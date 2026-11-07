import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { FeedbackBody } from '@/components/app/feedback/FeedbackPage'
import { SiteShell } from '@/components/app/SiteShell'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'
import { feedbackStatus } from '@/lib/feedback/feedback'
import { findOwnProject } from '@/lib/projects/project'

// "How did it go?" for the company ("Final pass" mockup, "Feedback after a project"): once its
// project closed after delivery. Read as the company user with access control on; another
// company's project is "not found". Only Konnected reads the answers; the student never does.
export const dynamic = 'force-dynamic'

export default async function CompanyFeedbackPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const project = /^\d{1,10}$/.test(id) ? await findOwnProject(payload, user, Number(id), 0) : null
  if (!project) notFound()
  const status = await feedbackStatus(payload, user, project.id)
  const t = await getTranslations('Feedback')
  const backHref = `/company/projects/${project.id}`

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="projects"
      crumb={{ href: backHref, label: t('backCompany') }}
      title={t('title')}
      lede={t('ledeCompany', { title: project.title })}
    >
      <FeedbackBody status={status} as="company" projectId={project.id} backHref={backHref} />
    </SiteShell>
  )
}
