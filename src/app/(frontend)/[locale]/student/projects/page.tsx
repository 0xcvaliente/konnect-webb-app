import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, SearchXIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { SiteShell } from '@/components/app/SiteShell'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Link, redirect } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { routing } from '@/i18n/routing'
import { browseOpenProjects } from '@/lib/projects/browse'
import { browseQuery, hasFilters, NO_FILTERS, readBrowseParams } from '@/lib/projects/browseFields'
import { requireStudent } from '@/lib/students/session'

import { ProjectCard } from './ProjectCard'
import { ProjectFilters } from './ProjectFilters'

// The student project list ("Final pass" mockup, Projects): open published projects only,
// searched, filtered and paged on the server, newest first. Read as the student with access
// control on. Companies and signed-out visitors are sent away (requireStudent), and the data
// function refuses them too. Nothing here reads any student's data.
export const dynamic = 'force-dynamic'

function Empty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof SearchIcon
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <Card className="items-center py-10 text-center">
      <Icon aria-hidden="true" className="size-8 text-primary" />
      <div className="grid max-w-[46ch] gap-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground">{body}</p>
      </div>
      {action}
    </Card>
  )
}

export default async function StudentProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user, account } = await requireStudent(locale)
  const filters = readBrowseParams(await searchParams)
  const result = await browseOpenProjects(payload, user, filters)
  if (!result) return redirect({ href: '/', locale })

  const t = await getTranslations('StudentProjects')
  const filtered = hasFilters(filters)
  const pageHref = (page: number) => `/student/projects${browseQuery(filters, page)}`

  let list: ReactNode
  if (result.cards.length > 0) {
    list = (
      <ul className="grid gap-[14px] sm:grid-cols-2" aria-label={t('listLabel')}>
        {result.cards.map((card) => (
          <li key={card.id} className="min-w-0">
            <ProjectCard project={card} />
          </li>
        ))}
      </ul>
    )
  } else if (result.totalDocs > 0) {
    list = (
      <Empty
        icon={SearchIcon}
        title={t('pastEndTitle')}
        body={t('pastEndBody')}
        action={
          <Button asChild variant="secondary">
            <Link href={pageHref(1)}>{t('firstPage')}</Link>
          </Button>
        }
      />
    )
  } else if (filtered) {
    list = (
      <Empty
        icon={SearchXIcon}
        title={t('noMatchTitle')}
        body={t('noMatchBody')}
        action={
          <Button asChild variant="secondary">
            <Link href={`/student/projects${browseQuery(NO_FILTERS)}`}>{t('clear')}</Link>
          </Button>
        }
      />
    )
  } else {
    list = (
      <Empty
        icon={SearchIcon}
        title={t('emptyTitle')}
        body={t('emptyBody')}
        action={
          <Button asChild variant="secondary">
            <Link href="/student/profile">{t('emptyAction')}</Link>
          </Button>
        }
      />
    )
  }

  const { page, totalPages } = result
  return (
    <SiteShell role="student" current="projects" user={account} title={t('title')} lede={t('lede')}>
      <Card className="gap-5">
        <ProjectFilters filters={filters} skillOptions={result.skills.map((s) => s.label)} />
      </Card>

      <section className="grid gap-[14px]" aria-labelledby="project-count">
        {/* With no results the empty card says it; the line stays for screen readers. */}
        <p
          id="project-count"
          role="status"
          className={cn(
            'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[0.9rem] text-muted-foreground',
            result.totalDocs === 0 && 'sr-only',
          )}
        >
          <span className="font-semibold text-foreground">
            {t('count', { count: result.totalDocs })}
          </span>
          {result.totalDocs > 1 && <span>{t('sorted')}</span>}
        </p>
        {list}
      </section>

      {totalPages > 1 && result.cards.length > 0 && (
        <nav
          aria-label={t('pages')}
          className="flex flex-wrap items-center justify-between gap-3 border-t-[1.5px] border-line pt-4"
        >
          {page > 1 ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={pageHref(page - 1)} rel="prev">
                <ChevronLeftIcon aria-hidden="true" />
                {t('previous')}
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-[0.9rem] text-muted-foreground tabular-nums" aria-current="page">
            {t('pageOf', { page, total: totalPages })}
          </span>
          {page < totalPages ? (
            <Button asChild variant="secondary" size="sm">
              <Link href={pageHref(page + 1)} rel="next">
                {t('next')}
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </SiteShell>
  )
}
