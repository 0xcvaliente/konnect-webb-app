'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TextField } from '@/components/app/AuthForm'
import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useRouter } from '@/i18n/navigation'
import { saveCompanyBillingAction, saveOwnBillingAction } from '@/lib/companies/billingActions'
import { BILLING_IDLE, BILLING_LIMITS, type BillingValues } from '@/lib/companies/fields'

/**
 * Billing details ("Final pass" mockup, Company profile, Billing): the invoice email, the
 * reference shown on every invoice, and whether the company takes e-invoices (EHF). The company
 * edits its own on the profile page (`as="company"`); the team edits any company's from the
 * payment log (`as="team"`, with the company id). The server checks who may save again.
 */
export function BillingForm({
  as,
  companyId,
  values,
  onDone,
}: {
  as: 'company' | 'team'
  companyId?: number
  values: BillingValues
  /** After a save (the team's form closes). */
  onDone?: () => void
}) {
  const t = useTranslations('Billing')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(
    as === 'team' ? saveCompanyBillingAction : saveOwnBillingAction,
    BILLING_IDLE,
  )
  // Controlled, so what was typed stays after a refused save.
  const [form, setForm] = useState(values)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.savedAt === seen.current) return
    seen.current = state.savedAt
    if (state.status === 'done') {
      toast(t('saved'))
      onDone?.()
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const fieldError = (name: 'invoiceEmail' | 'invoiceReference') => {
    const problem = state.status === 'error' ? state.fields?.[name] : undefined
    if (!problem) return undefined
    return problem === 'too_long'
      ? t('errors.too_long', { max: BILLING_LIMITS[name] })
      : t('errors.invalid')
  }

  return (
    <form action={run} className="grid gap-4" noValidate>
      {companyId !== undefined && <input type="hidden" name="companyId" value={companyId} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id={`${id}-email`}
          name="invoiceEmail"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          label={t('invoiceEmail')}
          hint={t('invoiceEmailHint')}
          maxLength={BILLING_LIMITS.invoiceEmail}
          value={form.invoiceEmail}
          onChange={(e) => setForm((f) => ({ ...f, invoiceEmail: e.target.value }))}
          error={fieldError('invoiceEmail')}
        />
        <TextField
          id={`${id}-ref`}
          name="invoiceReference"
          label={t('reference')}
          hint={t('referenceHint')}
          maxLength={BILLING_LIMITS.invoiceReference}
          autoComplete="off"
          value={form.invoiceReference}
          onChange={(e) => setForm((f) => ({ ...f, invoiceReference: e.target.value }))}
          error={fieldError('invoiceReference')}
        />
      </div>
      <div className="flex min-h-11 items-start gap-3">
        <Checkbox
          id={`${id}-ehf`}
          name="ehfInvoice"
          className="mt-0.5"
          checked={form.ehfInvoice}
          onCheckedChange={(checked) => setForm((f) => ({ ...f, ehfInvoice: checked === true }))}
          aria-describedby={`${id}-ehf-hint`}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${id}-ehf`}>{as === 'team' ? t('ehfTeam') : t('ehf')}</Label>
          <p id={`${id}-ehf-hint`} className="text-[0.82rem] text-muted-foreground">
            {t('ehfHint')}
          </p>
        </div>
      </div>
      {state.status === 'error' && state.error && (
        <Banner tone="bad" role="alert">
          <p>{t(`errors.${state.error}`)}</p>
        </Banner>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
          {t('save')}
        </Button>
        {onDone && (
          <Button type="button" variant="text" onClick={onDone}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}

/** The team's billing editor in the payment log: the details, and a form behind a button. */
export function TeamBilling({
  companyId,
  values,
  summary,
}: {
  companyId: number
  values: BillingValues
  summary: React.ReactNode
}) {
  const t = useTranslations('Billing')
  const [open, setOpen] = useState(false)
  return open ? (
    <BillingForm as="team" companyId={companyId} values={values} onDone={() => setOpen(false)} />
  ) : (
    <div className="grid gap-3">
      {summary}
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t('edit')}
        </Button>
      </div>
    </div>
  )
}
