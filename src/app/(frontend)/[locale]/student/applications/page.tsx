import { ChevronRightIcon, FileTextIcon } from 'lucide-react'
import { hasLocale, useFormatter, useTranslations } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { SiteShell } from '@/components/app/SiteShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { APPLICATION_STATUS_TONE, readSort } from '@/lib/applications/fields'
import { listOwnApplications, type OwnApplication } from '@/lib/applications/student'
import { requireStudent } from '@/lib/students/session'

import { useDay } from '../projects/ProjectCard'
import { SortSelect } from './SortSelect'

// "My applications" ("Final pass" mockup): every application of the signed-in student with its
// status pill, the dates, and when Konnected decides (3 working days after applications close).
// Read as the student with access control on, so only their own applications come back.
export const dynamic = 'force-dynamic'

/** One application row. The whole row opens the application. */
function Row({ application: a }: { application: OwnApplication }) {
  const t = useTranslations('Applications')
  const ts = useTranslations('ApplicationStatus')
  const format = useFormatter()
  const day = useDay()
  const at = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeZone: 'Europe/Oslo' })

  const deciding = a.status === 'applied' || a.status === 'shortlisted'
  const first = t('applied', { date: at(a.appliedAt) })
  let second: string | null = null
  if (a.status === 'withdrawn' && a.withdrawnAt)
    second = t('withdrawn', { date: at(a.withdrawnAt) })
  else if ((a.status === 'selected' || a.status === 'not_selected') && a.decidedAt)
    second = t('decided', { date: at(a.decidedAt) })
  else if (deciding)
    second = a.decideBy ? t('decideBy', { date: day(a.decideBy)! }) : t('decideSoon')

  return (
    <li>
      <Card className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 py-[18px] transition-colors has-[a:hover]:border-[color-mix(in_srgb,var(--line)_50%,var(--primary))] sm:py-5 md:grid-cols-[minmax(0,2.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_18px]">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyAvatar name={a.companyName} logoUrl={a.listed?.logoUrl} />
          <div className="grid min-w-0 gap-0.5">
            <h2 className="text-base leading-tight font-semibold [overflow-wrap:anywhere]">
              <Link
                href={`/student/applications/${a.id}`}
                prefetch={false}
                className="text-foreground no-underline after:absolute after:inset-0 after:rounded-card hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:after:ring-3 focus-visible:after:ring-primary focus-visible:after:ring-offset-2"
              >
                {a.title}
              </Link>
            </h2>
            <p className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
              {a.companyName}
            </p>
          </div>
        </div>
        <ChevronRightIcon
          aria-hidden="true"
          className="col-start-2 row-start-1 size-[18px] text-muted-foreground md:col-start-4"
        />
        <p className="col-span-2 grid text-[0.88rem] md:col-span-1 md:col-start-2 md:row-start-1">
          <span>{first}</span>
          {second && <span className="text-muted-foreground">{second}</span>}
        </p>
        <div className="col-span-2 md:col-span-1 md:col-start-3 md:row-start-1">
          <Badge tone={APPLICATION_STATUS_TONE[a.status]}>{ts(a.status)}</Badge>
        </div>
      </Card>
    </li>
  )
}

export default async function StudentApplicationsPage({
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
  const sort = readSort((await searchParams).sort)
  const applications = (await listOwnApplications(payload, user, sort)) ?? []
  const t = await getTranslations('Applications')

  if (applications.length === 0) {
    return (
      <SiteShell role="student" current="applications" user={account} title={t('title')}>
        <Card className="items-center py-10 text-center">
          <FileTextIcon aria-hidden="true" className="size-8 text-primary" />
          <div className="grid max-w-[46ch] gap-1">
            <h2 className="text-base font-semibold">{t('emptyTitle')}</h2>
            <p className="text-muted-foreground">{t('emptyBody')}</p>
          </div>
          <Button asChild>
            <Link href="/student/projects">{t('emptyAction')}</Link>
          </Button>
        </Card>
      </SiteShell>
    )
  }

  return (
    <SiteShell
      role="student"
      current="applications"
      user={account}
      title={t('title')}
      lede={t('lede')}
      overlap={false}
    >
      <SortSelect sort={sort} count={applications.length} />
      <div className="grid gap-2.5">
        <div
          aria-hidden="true"
          className="hidden gap-4 px-[26px] text-[0.8rem] font-semibold text-muted-foreground md:grid md:grid-cols-[minmax(0,2.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_18px]"
        >
          <span>{t('columns.project')}</span>
          <span>{t('columns.dates')}</span>
          <span>{t('columns.status')}</span>
          <span />
        </div>
        <ul className="grid gap-2.5" aria-label={t('listLabel')}>
          {applications.map((a) => (
            <Row key={a.id} application={a} />
          ))}
        </ul>
      </div>
    </SiteShell>
  )
}
