import { ChevronRightIcon, FileCogIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

import { AgreementStatusPill } from '@/components/app/agreements/AgreementParts'
import { MakeAgreementButton } from '@/components/app/agreements/TeamAgreementActions'
import { TeamShell } from '@/components/app/TeamShell'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import { AGREEMENT_KINDS } from '@/lib/agreements/fields'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import { requireTeam } from '@/lib/team/session'
import type { Agreement, Company, Match, Project, StudentProfile } from '@/payload-types'

// The team's agreements queue (mockup "Agreements"): what waits for Konnected's signature, what
// is to be made, what waits for the other side, what failed, and what is signed. Read as the team
// member with access control on.
export const dynamic = 'force-dynamic'

const partyName = (a: Agreement) =>
  a.kind === 'company'
    ? ((a.company as Company | null)?.name ?? '')
    : ((a.student as StudentProfile | null)?.name ?? '')

export default async function TeamAgreementsPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const t = await getTranslations('TeamAgreements')
  const a = await getTranslations('Agreements')
  const tRole = await getTranslations('Roles')
  const format = await getFormatter()
  const as = { user, overrideAccess: false as const }

  const agreements = (
    await payload.find({
      collection: 'agreements',
      sort: '-updatedAt',
      depth: 1,
      limit: 200,
      ...as,
    })
  ).docs as Agreement[]
  const inUse = new Set(agreements.map((x) => x.activeKey).filter(Boolean))

  const approved = (
    await payload.find({
      collection: 'projects',
      where: { status: { equals: 'approved' } },
      depth: 0,
      limit: 100,
      ...as,
    })
  ).docs as Project[]
  const matched = (
    await payload.find({
      collection: 'matches',
      where: { and: [{ 'project.status': { equals: 'matched' } }, ACTIVE_MATCH] },
      depth: 1,
      limit: 100,
      ...as,
    })
  ).docs as Match[]
  const toMake = [
    ...approved
      .filter((p) => !inUse.has(`company:${p.id}`))
      .map((p) => ({
        key: `p${p.id}`,
        title: p.title,
        detail: t('approvedProject', { company: p.companyName ?? '' }),
        button: <MakeAgreementButton kind="company" projectId={p.id} />,
      })),
    ...matched
      .filter((m) => !inUse.has(`student:${m.id}`))
      .map((m) => {
        const project = m.project as Project | null
        return {
          key: `m${m.id}`,
          title: project?.title ?? '',
          detail: `${t('matchedProject')}, ${(m.student as StudentProfile | null)?.name ?? ''}`,
          // The student agreement holds the dates agreed at kick-off: record the kick-off first.
          button: m.kickoff?.recordedAt ? (
            <MakeAgreementButton kind="student" matchId={m.id} />
          ) : (
            <div className="grid gap-1.5">
              <p className="text-[0.85rem] text-muted-foreground">{t('kickoffFirst')}</p>
              <div>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/team/projects/${project?.id ?? ''}`}>{t('recordKickoff')}</Link>
                </Button>
              </div>
            </div>
          ),
        }
      }),
  ]

  const templates = (
    await payload.find({
      collection: 'agreement-templates',
      where: { status: { equals: 'published' } },
      depth: 0,
      limit: 10,
      ...as,
    })
  ).docs

  const by = (statuses: Agreement['status'][]) =>
    agreements.filter((x) => statuses.includes(x.status))

  const row = (x: Agreement) => (
    <li key={x.id} className="border-b border-line last:border-b-0">
      <Link
        href={`/team/agreements/${x.id}`}
        prefetch={false}
        className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 rounded-item px-3 py-3 text-foreground no-underline hover:bg-surface-2"
      >
        <span className="grid min-w-0 flex-1 basis-56 gap-0.5">
          <b className="font-semibold [overflow-wrap:anywhere]">{x.title}</b>
          <span className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
            {a(`kindShort.${x.kind}`)}, {partyName(x)}, {x.reference},{' '}
            {format.dateTime(new Date(x.updatedAt), { dateStyle: 'medium' })}
          </span>
        </span>
        <AgreementStatusPill status={x.status} />
        <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </Link>
    </li>
  )

  const section = (title: string, items: Agreement[], empty: string, extra?: ReactNode) => (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>
          {title} <span className="text-muted-foreground tabular-nums">({items.length})</span>
        </CardTitle>
        {extra}
      </CardHeader>
      {items.length ? (
        <ul className="-mx-3 grid">{items.map(row)}</ul>
      ) : (
        <p className="text-[0.9rem] text-muted-foreground">{empty}</p>
      )}
    </Card>
  )

  const failed = by(['failed'])

  return (
    <TeamShell
      current="agreements"
      counts={{ agreements: by(['awaiting_konnected']).length + toMake.length }}
      user={accountMenuUser(user, tRole('admin'))}
      title={t('title')}
      lede={t('lede')}
      actions={
        <Button asChild variant="secondary">
          <Link href="/team/agreements/templates" prefetch={false}>
            <FileCogIcon aria-hidden="true" />
            {t('manage')}
          </Link>
        </Button>
      }
    >
      <div className="grid max-w-[980px] gap-5">
        {section(t('toSignTitle'), by(['awaiting_konnected']), t('toSignEmpty'))}

        <Card className="gap-3">
          <CardHeader>
            <CardTitle>
              {t('toMakeTitle')}{' '}
              <span className="text-muted-foreground tabular-nums">({toMake.length})</span>
            </CardTitle>
            <CardDescription>{t('toMakeBody')}</CardDescription>
          </CardHeader>
          {toMake.length ? (
            <ul className="grid">
              {toMake.map((item) => (
                <li
                  key={item.key}
                  className="grid gap-2 border-b border-line py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <b className="font-semibold [overflow-wrap:anywhere]">{item.title}</b>
                    <span className="text-[0.85rem] [overflow-wrap:anywhere] text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                  {item.button}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.9rem] text-muted-foreground">{t('toMakeEmpty')}</p>
          )}
        </Card>

        {section(t('waitingTitle'), by(['awaiting_party', 'generating']), t('waitingEmpty'))}
        {failed.length > 0 && section(t('problemsTitle'), failed, '')}
        {section(t('signedTitle'), by(['signed']).slice(0, 20), t('signedEmpty'))}

        <Card className="gap-3">
          <CardHeader>
            <CardTitle>{t('templatesTitle')}</CardTitle>
          </CardHeader>
          <ul className="grid">
            {AGREEMENT_KINDS.map((kind) => {
              const tpl = templates.find((x) => x.kind === kind)
              return (
                <li key={kind} className="grid gap-0.5 border-b border-line py-3 last:border-b-0">
                  <b className="font-semibold">{a(`kind.${kind}`)}</b>
                  <span className="text-[0.85rem] text-muted-foreground">
                    {tpl
                      ? t('publishedVersion', {
                          version: tpl.version ?? 0,
                          date: tpl.publishedAt
                            ? format.dateTime(new Date(tpl.publishedAt), { dateStyle: 'medium' })
                            : '',
                        })
                      : t('noPublished')}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </TeamShell>
  )
}
