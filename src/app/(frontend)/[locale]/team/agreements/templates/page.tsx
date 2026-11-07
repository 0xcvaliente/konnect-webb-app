import { FileTextIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import { TemplateButtons, TemplateUpload } from '@/components/app/agreements/TemplateUpload'
import { TeamShell } from '@/components/app/TeamShell'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { routing } from '@/i18n/routing'
import { accountMenuUser } from '@/lib/account'
import {
  AGREEMENT_KINDS,
  ALL_TEMPLATE_FIELDS,
  fieldMessageKey,
  TEMPLATE_FIELDS,
} from '@/lib/agreements/fields'
import { requireTeam } from '@/lib/team/session'
import type { AgreementTemplate } from '@/payload-types'

// Agreement templates (mockup "Agreement templates"): upload a new version of the company or the
// student agreement, publish or retire versions, and the list of fields a template may use.
// Admins only, on the page and in the collection.
export const dynamic = 'force-dynamic'

const TONE = { published: 'ok', draft: 'warn', retired: 'mute' } as const
const ORDER = { published: 0, draft: 1, retired: 2 } as const

export default async function AgreementTemplatesPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const t = await getTranslations('AgreementTemplates')
  const a = await getTranslations('Agreements')
  const f = await getTranslations('AgreementFields')
  const tRole = await getTranslations('Roles')
  const format = await getFormatter()

  const templates = (
    await payload.find({
      collection: 'agreement-templates',
      sort: '-version',
      depth: 0,
      limit: 200,
      user,
      overrideAccess: false,
    })
  ).docs as AgreementTemplate[]

  const onlyIn = (field: (typeof ALL_TEMPLATE_FIELDS)[number]) => {
    const company = TEMPLATE_FIELDS.company.includes(field)
    const student = TEMPLATE_FIELDS.student.includes(field)
    return company && !student ? t('companyOnly') : student && !company ? t('studentOnly') : null
  }

  return (
    <TeamShell
      current="templates"
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team/agreements', label: t('back') }}
      title={t('title')}
      lede={t('lede')}
    >
      <div className="grid max-w-[1100px] items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-5">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>{t('uploadTitle')}</CardTitle>
              <CardDescription>{t('uploadBody')}</CardDescription>
            </CardHeader>
            <TemplateUpload />
          </Card>

          {AGREEMENT_KINDS.map((kind) => {
            const versions = templates
              .filter((x) => x.kind === kind)
              .sort(
                (x, y) => ORDER[x.status] - ORDER[y.status] || (y.version ?? 0) - (x.version ?? 0),
              )
            return (
              <Card key={kind} className="gap-3">
                <CardTitle>{a(`kind.${kind}`)}</CardTitle>
                {versions.length ? (
                  <ul className="grid gap-2.5">
                    {versions.map((v) => (
                      <li
                        key={v.id}
                        className="grid gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <FileTextIcon
                            aria-hidden="true"
                            className="size-[22px] shrink-0 text-primary"
                          />
                          <div className="grid min-w-0 flex-1 gap-0.5">
                            <b className="font-semibold [overflow-wrap:anywhere]">
                              {v.originalName ?? v.filename}
                            </b>
                            <span className="text-[0.85rem] text-muted-foreground">
                              {t('versionLine', {
                                version: v.version ?? 0,
                                date: format.dateTime(new Date(v.createdAt), {
                                  dateStyle: 'medium',
                                }),
                              })}
                              {', '}
                              {t('fieldsCount', {
                                count: ((v.fields as string[] | null) ?? []).length,
                              })}
                            </span>
                          </div>
                          <Badge tone={TONE[v.status]}>{a(`templateStatus.${v.status}`)}</Badge>
                        </div>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <TemplateButtons templateId={v.id} status={v.status} />
                          {v.url && (
                            <a
                              href={v.url}
                              download
                              className="inline-flex min-h-11 items-center text-[0.88rem] font-semibold sm:min-h-8"
                            >
                              {a('download')}
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[0.9rem] text-muted-foreground">{t('noneOfKind')}</p>
                )}
              </Card>
            )
          })}
        </div>

        <aside className="grid min-w-0 gap-5">
          <Card className="gap-4">
            <CardHeader>
              <CardTitle>{t('fieldsTitle')}</CardTitle>
              <CardDescription>{t('fieldsBody')}</CardDescription>
            </CardHeader>
            <dl className="grid gap-2.5 text-[0.9rem]">
              {ALL_TEMPLATE_FIELDS.map((field) => {
                const only = onlyIn(field)
                return (
                  <div key={field} className="grid gap-0.5">
                    <dt>
                      <code className="font-mono text-[0.84rem] [overflow-wrap:anywhere] text-primary">{`{{${field}}}`}</code>
                    </dt>
                    <dd className="text-muted-foreground">
                      {f(fieldMessageKey(field))}
                      {only && <span className="block text-[0.8rem]">{only}</span>}
                    </dd>
                  </div>
                )
              })}
            </dl>
          </Card>
        </aside>
      </div>
    </TeamShell>
  )
}
