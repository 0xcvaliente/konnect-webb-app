import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { SiteShell } from '@/components/app/SiteShell'
import { redirect } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'
import { isEditable } from '@/lib/projects/display'
import { findOwnProject } from '@/lib/projects/project'
import { briefFilesOf, projectToInput } from '@/lib/projects/view'

import { ProjectForm } from '../../ProjectForm'

// Edit a draft, or a project Konnected asked changes on. Read as the company user with access
// control on: another company's project is "not found". Anything past review opens the project
// page instead; the collection refuses edits there anyway.
export const dynamic = 'force-dynamic'

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const project = await findOwnProject(payload, user, Number(id), 1)
  if (!project) notFound()
  if (!isEditable(project.status) || company.status === 'rejected') {
    return redirect({ href: `/company/projects/${project.id}`, locale })
  }

  const t = await getTranslations('ProjectForm')
  const logoUrl = typeof company.logo === 'object' ? company.logo?.url : null

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="projects"
      title={project.status === 'changes_requested' ? t('changesPageTitle') : t('editTitle')}
      lede={t('lede')}
    >
      <ProjectForm
        id={project.id}
        initial={projectToInput(project)}
        files={briefFilesOf(project)}
        canSend={company.status === 'approved'}
        companyName={company.name}
        companyLogoUrl={logoUrl}
        changesNote={project.status === 'changes_requested' ? (project.noteToCompany ?? '') : null}
      />
    </SiteShell>
  )
}
