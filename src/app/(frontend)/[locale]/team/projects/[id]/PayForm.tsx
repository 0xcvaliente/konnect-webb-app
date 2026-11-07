'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useRouter } from '@/i18n/navigation'
import { parsePrice } from '@/lib/money'
import { PAY_CHANGE_IDLE } from '@/lib/team/payChange'
import { changePayAction } from '@/lib/team/projectActions'

/**
 * The team's form to change a published project's price and the student's pay (owner answer 42).
 * A new price after the company signed its agreement, or a new pay after the student signed theirs,
 * shows a warning that the signed agreement keeps the old amount, and the team ticks that it
 * understands before saving (the server checks the tick too). The server checks the team member
 * and every rule again.
 */
export function PayForm({
  projectId,
  fee,
  studentPay,
  student,
  companySigned,
  studentSigned,
  invoice,
}: {
  projectId: number
  fee: number | null
  studentPay: number | null
  student: string
  companySigned: boolean
  studentSigned: boolean
  /** What happens to the payment log row: none, its price follows, or the invoice was sent. */
  invoice: { kind: 'none' } | { kind: 'open' } | { kind: 'sent'; date: string }
}) {
  const t = useTranslations('TeamProject.pay')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(changePayAction, PAY_CHANGE_IDLE)
  // When the form was opened. A save after that closes it again.
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  const open = openedAt !== null && !(state.status === 'done' && state.doneAt >= openedAt)
  const [priceText, setPriceText] = useState('')
  const [payText, setPayText] = useState('')
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') toast(t('saved'))
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  // Which signed agreement the typed change departs from.
  const typedFee = parsePrice(priceText) ?? null
  const typedPay = payText.trim() ? (parsePrice(payText) ?? null) : null
  const warnCompany = companySigned && typedFee !== null && typedFee !== fee
  const warnStudent = studentSigned && typedPay !== studentPay
  const signed = warnCompany || warnStudent
  const error = state.status === 'error' ? state.error : null

  return (
    <div className="grid gap-3">
      <div>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          aria-expanded={open}
          aria-controls={`${id}-form`}
          onClick={() => {
            setPriceText(fee === null ? '' : String(fee))
            setPayText(studentPay === null ? '' : String(studentPay))
            setOpenedAt(open ? null : Date.now())
          }}
        >
          {t('change')}
        </Button>
      </div>
      {open && (
        <form
          id={`${id}-form`}
          action={run}
          className="grid gap-3 rounded-item bg-surface-2 p-3.5"
          noValidate
        >
          <input type="hidden" name="id" value={projectId} />
          <input type="hidden" name="wasFee" value={fee ?? ''} />
          <input type="hidden" name="wasPay" value={studentPay ?? ''} />
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-price`}>{t('priceLabel')}</Label>
            <Input
              id={`${id}-price`}
              name="price"
              inputMode="numeric"
              autoComplete="off"
              required
              className="max-w-[16rem]"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              aria-invalid={error === 'price_invalid' || undefined}
              aria-describedby={`${id}-price-hint`}
            />
            <p id={`${id}-price-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('priceHint')}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-pay`}>{t('studentPayLabel')}</Label>
            <Input
              id={`${id}-pay`}
              name="studentPay"
              inputMode="numeric"
              autoComplete="off"
              className="max-w-[16rem]"
              value={payText}
              onChange={(e) => setPayText(e.target.value)}
              aria-invalid={error === 'student_pay_invalid' || undefined}
              aria-describedby={`${id}-pay-hint`}
            />
            <p id={`${id}-pay-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('studentPayHint')}
            </p>
          </div>

          {signed && (
            <Banner tone="warn">
              <p className="font-semibold">{t('signedTitle')}</p>
              {warnCompany && <p className="text-[0.88rem]">{t('signedCompany')}</p>}
              {warnStudent && <p className="text-[0.88rem]">{t('signedStudent', { student })}</p>}
              <div className="mt-2.5 flex items-start gap-2.5">
                <Checkbox
                  id={`${id}-confirm`}
                  name="confirm"
                  value="1"
                  className="mt-0.5"
                  aria-invalid={error === 'confirm' || undefined}
                />
                <Label htmlFor={`${id}-confirm`} className="text-[0.88rem] leading-snug">
                  {t('confirm')}
                </Label>
              </div>
            </Banner>
          )}
          {invoice.kind === 'sent' && (
            <p className="text-[0.85rem] text-muted-foreground">
              {t('invoiceSent', { date: invoice.date })}
            </p>
          )}
          {invoice.kind === 'open' && (
            <p className="text-[0.85rem] text-muted-foreground">{t('invoiceOpen')}</p>
          )}
          <p className="text-[0.85rem] text-muted-foreground">{t('logHint')}</p>
          {error && (
            <Banner tone="bad" role="alert">
              <p>{t(`errors.${error}`)}</p>
            </Banner>
          )}
          <div>
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
              {pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {pending ? t('saving') : t('save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
