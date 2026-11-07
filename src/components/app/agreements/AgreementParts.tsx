import { CheckIcon, DownloadIcon, FileTextIcon } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import type { AgreementKind, AgreementStatus, SignatureParty } from '@/lib/agreements/fields'
import { groupedHash } from '@/lib/agreements/pdf'
import { cn } from '@/lib/utils'

/*
 * Pieces of the agreement screens (mockups "Agreement" for students and startups, "Agreements"
 * for the team): the status pill, the PDF row, the steps, and the signing record.
 */

const TONE: Record<AgreementStatus, 'ok' | 'warn' | 'bad' | 'info' | 'mute'> = {
  generating: 'mute',
  awaiting_party: 'warn',
  awaiting_konnected: 'info',
  signed: 'ok',
  failed: 'bad',
  void: 'mute',
}

/** The status pill. `party` uses the words a company or a student sees. */
export async function AgreementStatusPill({
  status,
  party = false,
}: {
  status: AgreementStatus
  party?: boolean
}) {
  const t = await getTranslations('Agreements')
  return <Badge tone={TONE[status]}>{t(`${party ? 'partyStatus' : 'status'}.${status}`)}</Badge>
}

/** The fingerprint, grouped in fours, in a monospace face that wraps on phones. */
export function Fingerprint({ hash, className }: { hash: string; className?: string }) {
  return (
    <code
      className={cn(
        'font-mono text-[0.82rem] [overflow-wrap:anywhere] text-muted-foreground',
        className,
      )}
    >
      {groupedHash(hash)}
    </code>
  )
}

/** The PDF row: name, when and from what it was made, fingerprint, and a download button. */
export async function AgreementFile({
  url,
  name,
  sha,
  detail,
}: {
  url?: string | null
  name: string
  sha?: string | null
  detail?: string
}) {
  const t = await getTranslations('Agreements')
  return (
    <div className="grid gap-3 rounded-item border-[1.5px] border-line bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <FileTextIcon aria-hidden="true" className="size-[22px] shrink-0 text-primary" />
        <div className="min-w-0 flex-1 basis-[12rem]">
          <p className="font-semibold [overflow-wrap:anywhere]">{name}</p>
          {detail && <p className="text-[0.85rem] text-muted-foreground">{detail}</p>}
        </div>
        {url && (
          <Button asChild variant="secondary" size="sm">
            <a href={url} download>
              <DownloadIcon aria-hidden="true" />
              {t('download')}
            </a>
          </Button>
        )}
      </div>
      {sha && (
        <p className="grid gap-0.5 text-[0.85rem]">
          <span className="text-muted-foreground">{t('fingerprint')}</span>
          <Fingerprint hash={sha} />
        </p>
      )}
    </div>
  )
}

type Times = {
  generatedAt?: string | null
  partySignedAt?: string | null
  completedAt?: string | null
  emailedAt?: string | null
}

/** Made, you sign, Konnected signs, emailed, published or started. */
export async function AgreementSteps({
  kind,
  status,
  times,
}: {
  kind: AgreementKind
  status: AgreementStatus
  times: Times
}) {
  const t = await getTranslations('AgreementSign')
  const format = await getFormatter()
  const when = (iso?: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : null

  const made = Boolean(times.generatedAt)
  const partyDone = Boolean(times.partySignedAt)
  const signed = status === 'signed'
  const steps: { label: string; detail: string | null; state: 'done' | 'current' | 'todo' }[] = [
    { label: t('step1'), detail: when(times.generatedAt), state: made ? 'done' : 'current' },
    {
      label: t('step2'),
      detail: partyDone ? when(times.partySignedAt) : made ? t('now') : null,
      state: partyDone ? 'done' : made && status === 'awaiting_party' ? 'current' : 'todo',
    },
    {
      label: t('step3'),
      detail: signed ? when(times.completedAt) : t('usually'),
      state: signed ? 'done' : status === 'awaiting_konnected' ? 'current' : 'todo',
    },
    {
      label: t('step4'),
      detail: times.emailedAt ? when(times.emailedAt) : t('automatically'),
      state: times.emailedAt ? 'done' : 'todo',
    },
    {
      label: kind === 'company' ? t('step5Company') : t('step5Student'),
      detail: signed ? t('done') : t('afterBoth'),
      state: signed ? 'done' : 'todo',
    },
  ]

  return (
    <Card className="gap-4">
      <CardTitle>{t('stepsTitle')}</CardTitle>
      <ol className="grid gap-2.5">
        {steps.map((step, i) => (
          <li
            key={step.label}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="grid grid-cols-[28px_minmax(0,1fr)] gap-3"
          >
            <span
              aria-hidden="true"
              className={cn(
                'grid size-7 place-items-center rounded-full border-[1.5px] text-[0.8rem] font-bold',
                step.state === 'done' && 'border-success text-success',
                step.state === 'current' && 'border-primary bg-primary text-primary-foreground',
                step.state === 'todo' && 'border-input text-muted-foreground',
              )}
            >
              {step.state === 'done' ? <CheckIcon className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className="grid gap-0.5">
              <b className="font-semibold">{step.label}</b>
              {step.detail && (
                <span className="text-[0.85rem] text-muted-foreground">{step.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  )
}

export type SignatureLine = {
  party: SignatureParty
  typedName: string
  signedAt: string
  signInMethod: 'google' | 'email_link' | 'password' | 'unknown'
}

/** Who signed, when, and how they had signed in; the fingerprint; that it cannot change. */
export async function SigningRecord({
  signatures,
  partyLabel,
  sha,
  note = true,
}: {
  signatures: SignatureLine[]
  /** The name to show for the company or student line. */
  partyLabel?: string
  sha?: string | null
  note?: boolean
}) {
  const t = await getTranslations('AgreementSign')
  const a = await getTranslations('Agreements')
  const format = await getFormatter()
  return (
    <Card className="gap-4">
      <CardTitle>{t('recordTitle')}</CardTitle>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[0.9rem]">
        {signatures.map((s) => (
          <div key={s.party} className="contents">
            <dt className="text-muted-foreground">
              {s.party === 'konnected' ? 'Konnected' : (partyLabel ?? a(`party.${s.party}`))}
            </dt>
            <dd className="grid gap-0.5 [overflow-wrap:anywhere]">
              <span className="font-medium">
                {t('recordLine', {
                  name: s.typedName,
                  date: format.dateTime(new Date(s.signedAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </span>
              <span className="text-[0.85rem] text-muted-foreground">
                {t('signedInWith', { method: a(`method.${s.signInMethod}`) })}
              </span>
            </dd>
          </div>
        ))}
        {sha && (
          <>
            <dt className="text-muted-foreground">{t('recordFingerprint')}</dt>
            <dd>
              <Fingerprint hash={sha} />
            </dd>
          </>
        )}
      </dl>
      {note && <p className="text-[0.85rem] text-muted-foreground">{t('immutable')}</p>}
    </Card>
  )
}
