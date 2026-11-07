'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { acceptDeliverableAction, requestFixAction } from '@/lib/deliverables/actions'
import { DELIVERABLE_IDLE, type DeliverableState, NOTE_MAX } from '@/lib/deliverables/fields'

function useDecision(
  action: (state: DeliverableState, form: FormData) => Promise<DeliverableState>,
  done: string,
) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, DELIVERABLE_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') toast(done)
    // Show what is true now, also after an error (someone may have acted first).
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

/**
 * "Accept the work" and "Ask for a fix" on the company's project page ("Final pass" mockup,
 * project page after release). The fix box says what happens: one round, within 7 days, the
 * student sees the note and Konnected checks the fixed work first. The server checks it all again.
 */
export function CompanyDecision({
  deliverableId,
  canAskFix,
  fixUntil,
}: {
  deliverableId: number
  canAskFix: boolean
  /** The last day to ask, in words. */
  fixUntil: string | null
}) {
  const t = useTranslations('CompanyWork')
  const te = useTranslations('Deliverables.errors')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const accept = useDecision(acceptDeliverableAction, t('acceptedToast'))
  const fix = useDecision(requestFixAction, t('fixToast'))
  const busy = accept.pending || fix.pending
  const error =
    accept.state.status === 'error'
      ? accept.state.error
      : fix.state.status === 'error'
        ? fix.state.error
        : null

  return (
    <div className="grid gap-3">
      <p className="text-[0.88rem] text-muted-foreground">
        {canAskFix && fixUntil ? t('decideHint', { date: fixUntil }) : t('decideHintFixed')}
      </p>
      {error && (
        <Banner tone="bad" role="alert">
          <p>{te(error)}</p>
        </Banner>
      )}
      <div className="flex flex-wrap gap-2.5">
        <form action={accept.run}>
          <input type="hidden" name="id" value={deliverableId} />
          <Button type="submit" disabled={busy} aria-busy={accept.pending || undefined}>
            {accept.pending && (
              <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
            )}
            {t('accept')}
          </Button>
        </form>
        {canAskFix && (
          <Button
            type="button"
            variant="secondary"
            aria-expanded={open}
            aria-controls={`${id}-fix`}
            onClick={() => setOpen((v) => !v)}
          >
            {t('askFix')}
          </Button>
        )}
      </div>
      {canAskFix && open && (
        <form
          id={`${id}-fix`}
          action={fix.run}
          className="grid gap-3 rounded-item bg-surface-2 p-3.5"
        >
          <input type="hidden" name="id" value={deliverableId} />
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('fixLabel')}</Label>
            <Textarea
              id={`${id}-note`}
              name="fixNote"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              maxLength={NOTE_MAX}
              aria-describedby={`${id}-hint`}
            />
            <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('fixHint')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy} aria-busy={fix.pending || undefined}>
              {fix.pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('sendFix')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
