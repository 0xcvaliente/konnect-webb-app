import { CircleCheckIcon, ClockIcon, FileTextIcon, InfoIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Banner } from '@/components/app/Banner'
import { Card, CardTitle } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import type { AgreementView } from '@/lib/agreements/views'

import { AgreementFile, AgreementStatusPill, AgreementSteps, SigningRecord } from './AgreementParts'
import { SignForm } from './SignForm'

/**
 * The agreement page for the company or the student (mockup "Agreement", states "To sign" and
 * "Signed"): what to do now, the PDF to read, the steps, and the sign form or the signing record.
 */
export async function PartyAgreement({
  view,
  role,
  companyName,
}: {
  view: AgreementView
  role: 'company' | 'student'
  /** The company's own name, for the "I may sign for" box. */
  companyName?: string | null
}) {
  const t = await getTranslations('AgreementSign')
  const a = await getTranslations('Agreements')
  const format = await getFormatter()
  const { agreement, unsigned, signed, signatures } = view
  const status = agreement.status
  const date = (iso?: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'long' }) : ''
  const after = role === 'company' ? t('afterCompany') : t('afterStudent')
  const showPdf = signed ?? unsigned

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/${role}/agreements`} className="text-[0.88rem] font-semibold">
          {t('back')}
        </Link>
      </div>
      <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-6 sm:gap-[26px]">
          {status === 'awaiting_party' && (
            <Banner icon={InfoIcon}>
              <p className="font-semibold">{t('readTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">
                {after} {t('emailNote')}
              </p>
            </Banner>
          )}
          {status === 'awaiting_konnected' && (
            <Banner tone="info" icon={ClockIcon}>
              <p className="font-semibold">{t('waitingTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('waitingBody')}</p>
            </Banner>
          )}
          {status === 'signed' && (
            <Banner tone="ok" icon={CircleCheckIcon}>
              <p className="font-semibold">{t('signedTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">
                {agreement.emailedAt
                  ? t('signedBody', { date: date(agreement.emailedAt) })
                  : t('signedSending')}
              </p>
            </Banner>
          )}
          {status === 'void' && (
            <Banner tone="warn">
              <p className="font-semibold">{t('voidTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('voidBody')}</p>
            </Banner>
          )}
          {(status === 'generating' || status === 'failed') && (
            <Banner icon={ClockIcon}>
              <p className="font-semibold">{t('pendingTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('pendingBody')}</p>
            </Banner>
          )}

          <Card className="gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <FileTextIcon aria-hidden="true" className="size-5 text-primary" />
                {t('pdfTitle')}
              </CardTitle>
              <AgreementStatusPill status={status} party />
            </div>
            {showPdf ? (
              <AgreementFile
                url={showPdf.url}
                name={
                  signed
                    ? a('signedPdfName', { reference: agreement.reference })
                    : a('pdfName', { reference: agreement.reference })
                }
                detail={a('madeFromShort', { date: date(agreement.generatedAt) })}
                sha={signed ? agreement.signedSha256 : agreement.unsignedSha256}
              />
            ) : null}
            {status === 'awaiting_party' && (
              <p className="text-[0.85rem] text-muted-foreground">{t('pdfHint')}</p>
            )}
          </Card>
        </div>

        <aside className="grid min-w-0 gap-6 sm:gap-[26px]">
          {status !== 'void' && (
            <AgreementSteps
              kind={agreement.kind}
              status={status}
              times={{
                generatedAt: agreement.generatedAt,
                partySignedAt: agreement.partySignedAt,
                completedAt: agreement.completedAt,
                emailedAt: agreement.emailedAt,
              }}
            />
          )}
          {status === 'awaiting_party' && agreement.unsignedSha256 && (
            <Card className="gap-4">
              <CardTitle>{t('signTitle')}</CardTitle>
              <SignForm
                agreementId={agreement.id}
                documentSha256={agreement.unsignedSha256}
                company={role === 'company' ? (companyName ?? '') : null}
              />
            </Card>
          )}
          {signatures.length > 0 && (
            <SigningRecord
              signatures={signatures}
              partyLabel={role === 'company' ? (companyName ?? undefined) : t('recordYou')}
              sha={agreement.unsignedSha256}
              note={status === 'signed'}
            />
          )}
        </aside>
      </div>
    </>
  )
}
