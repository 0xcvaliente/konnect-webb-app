'use client'

import { LoaderCircleIcon, PenLineIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useRouter } from '@/i18n/navigation'
import { signAgreementAction } from '@/lib/agreements/actions'
import { NAME_MAX } from '@/lib/agreements/fields'
import { IDLE } from '@/lib/agreements/state'

/**
 * Sign an agreement: tick "I have read and agree" (a company also ticks that it may sign for the
 * company), type the full name, sign. The fingerprint of the PDF on the page goes with the form;
 * the server refuses the signature if the stored PDF is not that one. The server decides
 * everything; this form only asks and reports.
 */
export function SignForm({
  agreementId,
  documentSha256,
  company,
  submitLabel,
  doneMessage,
}: {
  agreementId: number
  documentSha256: string
  /** The company's name: show the "I may sign for" box. */
  company?: string | null
  submitLabel?: string
  doneMessage?: string
}) {
  const t = useTranslations('AgreementSign')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(signAgreementAction, IDLE)
  const seen = useRef<number | undefined>(undefined)
  // Controlled, so an answer from the server (an error) does not clear what was typed or ticked.
  const [agree, setAgree] = useState(false)
  const [authority, setAuthority] = useState(false)
  const [name, setName] = useState('')

  useEffect(() => {
    if (state.status !== 'done' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    toast(doneMessage ?? t('signedToast'))
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const error = state.status === 'error' ? state.error : null
  const nameError = error === 'name_required' || error === 'name_too_long'
  const errorKey = error && error in ERRORS ? (error as keyof typeof ERRORS) : 'generic'

  return (
    <form action={run} className="grid gap-4" noValidate>
      <input type="hidden" name="agreementId" value={agreementId} />
      <input type="hidden" name="documentSha256" value={documentSha256} />
      <div className="grid gap-1">
        <label htmlFor={`${id}-agree`} className="flex min-h-11 items-start gap-3 py-1">
          <Checkbox
            id={`${id}-agree`}
            name="agree"
            checked={agree}
            onCheckedChange={(v) => setAgree(v === true)}
            className="mt-0.5"
            aria-invalid={error === 'not_ticked' || undefined}
          />
          <span className="font-semibold">{t('agree')}</span>
        </label>
        {company && (
          <label htmlFor={`${id}-authority`} className="flex min-h-11 items-start gap-3 py-1">
            <Checkbox
              id={`${id}-authority`}
              name="authority"
              checked={authority}
              onCheckedChange={(v) => setAuthority(v === true)}
              className="mt-0.5"
              aria-invalid={error === 'authority_not_ticked' || undefined}
            />
            <span className="font-semibold">{t('authority', { company })}</span>
          </label>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{t('typedName')}</Label>
        <Input
          id={`${id}-name`}
          name="typedName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
          maxLength={NAME_MAX}
          aria-invalid={nameError || undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
        />
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('typedNameHint')}
        </p>
      </div>
      {error && (
        <Banner tone="bad" role="alert" id={`${id}-error`}>
          <p>{t(`errors.${ERRORS[errorKey]}`)}</p>
        </Banner>
      )}
      <div>
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending ? (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <PenLineIcon aria-hidden="true" />
          )}
          {pending ? t('signing') : (submitLabel ?? t('sign'))}
        </Button>
      </div>
      <p className="text-[0.85rem] text-muted-foreground">{t('recordNote')}</p>
    </form>
  )
}

const ERRORS = {
  forbidden: 'forbidden',
  not_found: 'not_found',
  not_your_turn: 'not_your_turn',
  already_signed: 'already_signed',
  not_ticked: 'not_ticked',
  authority_not_ticked: 'authority_not_ticked',
  name_required: 'name_required',
  name_too_long: 'name_too_long',
  document_changed: 'document_changed',
  generic: 'generic',
} as const
