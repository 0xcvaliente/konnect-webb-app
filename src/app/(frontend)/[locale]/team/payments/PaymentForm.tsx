'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Link, useRouter } from '@/i18n/navigation'
import { INVOICE_NUMBER_MAX, PAYMENT_IDLE, PAYMENT_NOTES_MAX } from '@/lib/payments/fields'
import { savePaymentAction } from '@/lib/team/paymentActions'

/**
 * One row of the payment log, edited by hand ("Konnected team daily work" mockup, Payments, pilot
 * state): the invoice number, when the invoice was sent, when the company paid, when the student
 * was paid (only after the company paid), and the team's notes. The server checks the order of
 * the dates again and writes each change to the activity log.
 */
export function PaymentForm({
  paymentId,
  version,
  today,
  values,
  backHref,
}: {
  paymentId: number
  /** The row's `updatedAt` when it loaded; the server refuses the save if the row changed since. */
  version: string
  /** Today in Oslo (`YYYY-MM-DD`): no date after it. */
  today: string
  values: {
    invoiceNumber: string | null
    invoiceSent: string | null
    invoicePaid: string | null
    studentPaid: string | null
    notes: string | null
  }
  backHref: string
}) {
  const t = useTranslations('TeamPayments')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(savePaymentAction, PAYMENT_IDLE)
  const seen = useRef<number | undefined>(undefined)
  // Controlled, so what was typed stays after a refused save (React resets a form after its action).
  const [form, setForm] = useState(() => ({
    invoiceNumber: values.invoiceNumber ?? '',
    invoiceSent: values.invoiceSent ?? '',
    invoicePaid: values.invoicePaid ?? '',
    studentPaid: values.studentPaid ?? '',
    notes: values.notes ?? '',
  }))
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'saved') {
      toast(t('savedToast'))
      router.replace(backHref, { scroll: false })
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const field = (name: 'invoiceSent' | 'invoicePaid' | 'studentPaid', hint?: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`${id}-${name}`}>{t(`form.${name}`)}</Label>
      <Input
        id={`${id}-${name}`}
        name={name}
        type="date"
        max={today}
        value={form[name]}
        onChange={set(name)}
        aria-describedby={hint ? `${id}-${name}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-${name}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )

  return (
    <form action={run} className="grid gap-4">
      <input type="hidden" name="id" value={paymentId} />
      <input type="hidden" name="version" value={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-number`}>{t('form.invoiceNumber')}</Label>
          <Input
            id={`${id}-number`}
            name="invoiceNumber"
            maxLength={INVOICE_NUMBER_MAX}
            value={form.invoiceNumber}
            onChange={set('invoiceNumber')}
            autoComplete="off"
          />
        </div>
        {field('invoiceSent', t('form.invoiceSentHint'))}
        {field('invoicePaid')}
        {field('studentPaid', t('form.studentPaidHint'))}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-notes`}>{t('form.notes')}</Label>
        <Textarea
          id={`${id}-notes`}
          name="notes"
          rows={3}
          maxLength={PAYMENT_NOTES_MAX}
          value={form.notes}
          onChange={set('notes')}
          aria-describedby={`${id}-notes-hint`}
        />
        <p id={`${id}-notes-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('form.notesHint')}
        </p>
      </div>
      {state.status === 'error' && (
        <Banner tone="bad" role="alert">
          <p>{t(`errors.${state.error}`)}</p>
        </Banner>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
          {t('form.save')}
        </Button>
        <Button asChild variant="secondary">
          <Link href={backHref} prefetch={false}>
            {t('form.cancel')}
          </Link>
        </Button>
      </div>
    </form>
  )
}
