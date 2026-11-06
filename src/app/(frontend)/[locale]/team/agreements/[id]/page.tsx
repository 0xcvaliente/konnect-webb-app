import { CircleAlertIcon, CircleCheckIcon, ClockIcon } from 'lucide-react'
import { hasLocale } from 'next-intl'
import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'

import {
  AgreementFile,
  AgreementStatusPill,
  SigningRecord,
} from '@/components/app/agreements/AgreementParts'
import { SignForm } from '@/components/app/agreements/SignForm'
import { WithdrawAgreement } from '@/components/app/agreements/TeamAgreementActions'
import { Banner } from '@/components/app/Banner'
import { TeamShell } from '@/components/app/TeamShell'
import { Card, CardTitle } from '@/components/ui/card'
import { routing } from '@/i18n/routing'
import { relationId } from '@/access/roles'
import { accountMenuUser } from '@/lib/account'
import { ALL_TEMPLATE_FIELDS, fieldMessageKey, VOIDABLE } from '@/lib/agreements/fields'
import { loadAgreementView } from '@/lib/agreements/views'
import { requireTeam } from '@/lib/team/session'
import type { Company, StudentProfile } from '@/payload-types'

// One agreement for the team: details, the PDFs, what was filled in, the signatures, and the
// team's actions: sign for Konnected (last), or withdraw and make a new one.
export const dynamic = 'force-dynamic'

export default async function TeamAgreementPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>
}) {
  const { locale, id } = await params
  if (!hasLocale(routing.locales, locale)) notFound()
  setRequestLocale(locale)
  const { payload, user } = await requireTeam(locale)
  const view = await loadAgreementView(payload, user, Number(id))
  if (!view) notFound()
  const { agreement, unsigned, signed, signatures } = view

  const t = await getTranslations('TeamAgreements')
  const a = await getTranslations('Agreements')
  const f = await getTranslations('AgreementFields')
  const tRole = await getTranslations('Roles')
  const format = await getFormatter()
  const when = (iso?: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : ''

  // The other party's name, as the team sees it.
  const party =
    agreement.kind === 'company'
      ? ((
          (await payload.findByID({
            collection: 'companies',
            id: relationId(agreement.company)!,
            depth: 0,
            user,
            overrideAccess: false,
            disableErrors: true,
          })) as Company | null
        )?.name ?? '')
      : ((
          (await payload.findByID({
            collection: 'student-profiles',
            id: relationId(agreement.student)!,
            depth: 0,
            user,
            overrideAccess: false,
            disableErrors: true,
          })) as StudentProfile | null
        )?.name ?? '')

  // In the order of the field list, not the stored order.
  const order = (field: string) => {
    const i = (ALL_TEMPLATE_FIELDS as readonly string[]).indexOf(field)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const values = Object.entries((agreement.values ?? {}) as Record<string, string>).sort(
    ([x], [y]) => order(x) - order(y),
  )
  const failure = agreement.failure ?? ''
  const partySignature = signatures.find((s) => s.party !== 'konnected')

  return (
    <TeamShell
      current="agreements"
      user={accountMenuUser(user, tRole('admin'))}
      crumb={{ href: '/team/agreements', label: t('back') }}
      title={agreement.title}
      meta={
        <>
          <AgreementStatusPill status={agreement.status} />
          <span className="text-[0.88rem] text-muted-foreground">
            {a(`kind.${agreement.kind}`)}, {agreement.reference}
          </span>
        </>
      }
    >
      <div className="grid max-w-[1100px] items-start gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-5">
          {agreement.status === 'awaiting_konnected' && agreement.unsignedSha256 && (
            <Card className="gap-4">
              <CardTitle>{t('signKonnectedTitle')}</CardTitle>
              <p className="text-[0.9rem] text-muted-foreground">
                {t('signKonnectedBody', {
                  party: a(`party.${agreement.kind}`).toLowerCase(),
                  date: when(agreement.partySignedAt),
                })}
              </p>
              <SignForm
                agreementId={agreement.id}
                documentSha256={agreement.unsignedSha256}
                submitLabel={t('signKonnectedTitle')}
                doneMessage={a('status.signed')}
              />
            </Card>
          )}
          {agreement.status === 'awaiting_party' && (
            <Banner icon={ClockIcon}>
              <p>{t('notYet', { party: a(`party.${agreement.kind}`).toLowerCase() })}</p>
            </Banner>
          )}
          {agreement.status === 'signed' && (
            <Banner tone="ok" icon={CircleCheckIcon}>
              <p className="font-semibold">{a('status.signed')}</p>
              <p className="text-[0.88rem] text-muted-foreground">
                {agreement.emailedAt
                  ? t('emailed', { date: when(agreement.emailedAt) })
                  : t('emailPending')}
              </p>
            </Banner>
          )}
          {agreement.status === 'failed' && (
            <Banner tone="bad" icon={CircleAlertIcon}>
              <p>
                {failure.startsWith('missing_value:')
                  ? t('failure.missing_value', {
                      field: f(fieldMessageKey(failure.slice('missing_value:'.length))),
                    })
                  : t(failure === 'converter' ? 'failure.converter' : 'failure.template')}
              </p>
            </Banner>
          )}

          <Card className="gap-4">
            <CardTitle>{t('detailsTitle')}</CardTitle>
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-[0.9rem]">
              <dt className="text-muted-foreground">{t('party')}</dt>
              <dd className="font-medium [overflow-wrap:anywhere]">
                {a(`party.${agreement.kind}`)}: {party}
              </dd>
              <dt className="text-muted-foreground">{t('templateUsed')}</dt>
              <dd>
                {t('templateVersion', {
                  kind: a(`kind.${agreement.kind}`),
                  version: agreement.templateVersion ?? 0,
                })}
              </dd>
              <dt className="text-muted-foreground">{t('made')}</dt>
              <dd>{when(agreement.generatedAt ?? agreement.createdAt)}</dd>
              <dt className="text-muted-foreground">{a('reference')}</dt>
              <dd>{agreement.reference}</dd>
            </dl>
            {unsigned && (
              <AgreementFile
                url={unsigned.url}
                name={a('pdfName', { reference: agreement.reference })}
                sha={agreement.unsignedSha256}
              />
            )}
            {signed && (
              <AgreementFile
                url={signed.url}
                name={a('signedPdfName', { reference: agreement.reference })}
                sha={agreement.signedSha256}
              />
            )}
          </Card>

          {values.length > 0 && (
            <Card className="gap-4">
              <CardTitle>{t('valuesTitle')}</CardTitle>
              <dl className="grid gap-x-4 gap-y-2 text-[0.9rem] sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
                {values.map(([field, value]) => (
                  <div key={field} className="contents">
                    <dt className="text-muted-foreground">{f(fieldMessageKey(field))}</dt>
                    <dd className="mb-1 [overflow-wrap:anywhere] whitespace-pre-line sm:mb-0">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>

        <aside className="grid min-w-0 gap-5">
          {signatures.length > 0 && (
            <SigningRecord
              signatures={signatures}
              partyLabel={partySignature ? party : undefined}
              sha={agreement.unsignedSha256}
              note={agreement.status === 'signed'}
            />
          )}
          {VOIDABLE.includes(agreement.status) && (
            <Card className="gap-4">
              <CardTitle>{t('withdrawTitle')}</CardTitle>
              <WithdrawAgreement agreementId={agreement.id} />
            </Card>
          )}
        </aside>
      </div>
    </TeamShell>
  )
}
