import config from '@payload-config'
import { FolderOpenIcon, PlusIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { getPayload } from 'payload'

import { Banner } from '@/components/app/Banner'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { companyShellProps } from '@/lib/companies/display'
import { requireOwnCompany } from '@/lib/companies/session'
import { isEditable, PROJECT_STATUS_TONE } from '@/lib/projects/display'
import { listOwnProjects } from '@/lib/projects/project'

// "My projects" ("Final pass" mockup): every project of the company with its status. Read as the
// company user with access control on, so only its own projects come back. Konnected handles the
// students: nothing here names or links to any student.
export const dynamic = 'force-dynamic'

export default async function CompanyProjectsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { user, company } = await requireOwnCompany(locale)
  const payload = await getPayload({ config })
  const projects = await listOwnProjects(payload, user)

  const t = await getTranslations('CompanyProjects')
  const s = await getTranslations('ProjectStatus')
  const format = await getFormatter()
  const canStart = company.status !== 'rejected'

  return (
    <SiteShell
      {...companyShellProps(user, company)}
      current="projects"
      title={t('title')}
      lede={t('lede')}
      actions={
        canStart && projects.length > 0 ? (
          <Button asChild variant="band">
            <Link href="/company/projects/new">
              <PlusIcon aria-hidden="true" />
              {t('submit')}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {projects.length === 0 ? (
        <Card className="items-center py-10 text-center">
          <FolderOpenIcon aria-hidden="true" className="size-8 text-primary" />
          <div className="grid max-w-[46ch] gap-1">
            <h2 className="text-base font-semibold">{t('emptyTitle')}</h2>
            <p className="text-muted-foreground">{t('emptyBody')}</p>
          </div>
          {canStart && (
            <Button asChild>
              <Link href="/company/projects/new">{t('emptyAction')}</Link>
            </Button>
          )}
        </Card>
      ) : (
        <ul className="grid gap-[14px]" aria-label={t('listLabel')}>
          {projects.map((project) => {
            const editable = isEditable(project.status) && canStart
            return (
              <li key={project.id}>
                <Card className="gap-4">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="grid min-w-0 gap-0.5">
                      <h2 className="text-base leading-tight font-semibold [overflow-wrap:anywhere]">
                        <Link href={`/company/projects/${project.id}`} className="text-foreground">
                          {project.title}
                        </Link>
                      </h2>
                      <p className="text-[0.85rem] text-muted-foreground">
                        {s(`line.${project.status}`)}{' '}
                        {t('updated', {
                          date: format.dateTime(new Date(project.updatedAt), {
                            dateStyle: 'medium',
                            timeZone: 'Europe/Oslo',
                          }),
                        })}
                      </p>
                    </div>
                    <Badge tone={PROJECT_STATUS_TONE[project.status]}>
                      {s(`pill.${project.status}`)}
                    </Badge>
                  </div>
                  {project.status === 'changes_requested' && (
                    <Banner tone="warn">
                      <p className="[overflow-wrap:anywhere] whitespace-pre-line">
                        <b className="font-semibold">{t('asks')}</b>{' '}
                        {project.noteToCompany?.trim() || t('asksFallback')}
                      </p>
                    </Banner>
                  )}
                  {editable && (
                    <div className="flex flex-wrap gap-3">
                      <Button asChild variant="normal" size="sm">
                        <Link href={`/company/projects/${project.id}/edit`}>
                          {project.status === 'draft' ? t('finish') : t('resubmit')}
                          <span className="sr-only">: {project.title}</span>
                        </Link>
                      </Button>
                    </div>
                  )}
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </SiteShell>
  )
}
