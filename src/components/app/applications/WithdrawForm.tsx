'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { useRouter } from '@/i18n/navigation'
import { withdrawAction } from '@/lib/applications/actions'
import { WITHDRAW_IDLE } from '@/lib/applications/fields'

/**
 * "Changed your mind?" ("Final pass" mockup, application page): one button that opens a
 * confirmation saying withdrawing is final, then withdraws. The server checks the student and the
 * status again.
 */
export function WithdrawForm({ applicationId }: { applicationId: number }) {
  const t = useTranslations('Application')
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, run, pending] = useActionState(withdrawAction, WITHDRAW_IDLE)
  const seen = useRef<number | undefined>(undefined)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.status !== 'done' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    toast(t('withdrawnToast'))
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  useEffect(() => {
    if (open) confirmRef.current?.focus()
  }, [open])

  const error = state.status === 'error' ? state.error : null

  if (!open) {
    return (
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        aria-expanded={false}
        aria-controls={`${id}-confirm`}
        onClick={() => setOpen(true)}
      >
        {t('withdraw')}
      </Button>
    )
  }
  return (
    <div
      id={`${id}-confirm`}
      ref={confirmRef}
      tabIndex={-1}
      className="grid gap-3 rounded-item bg-surface-2 p-3.5 outline-none"
      aria-labelledby={`${id}-title`}
      role="group"
    >
      <div className="grid gap-0.5">
        <p id={`${id}-title`} className="font-semibold">
          {t('confirmTitle')}
        </p>
        <p className="text-[0.88rem] text-muted-foreground">{t('confirmBody')}</p>
      </div>
      {error && (
        <Banner tone="bad" role="alert">
          <p>{t(`errors.${error}`)}</p>
        </Banner>
      )}
      <form action={run} className="flex flex-wrap gap-2.5">
        <input type="hidden" name="applicationId" value={applicationId} />
        <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
          {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
          {pending ? t('withdrawing') : t('confirmYes')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          {t('keep')}
        </Button>
      </form>
    </div>
  )
}
