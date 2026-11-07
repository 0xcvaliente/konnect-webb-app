'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { DELIVERABLE_IDLE, type DeliverableState, NOTE_MAX } from '@/lib/deliverables/fields'
import { releaseAction, returnAction } from '@/lib/team/deliverableActions'

const CHECKS = ['matches', 'language', 'opens'] as const
const TEMPLATES = ['missing', 'language', 'broken'] as const

function useDecision(
  action: (state: DeliverableState, form: FormData) => Promise<DeliverableState>,
  done: string,
  goTo?: string,
) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, DELIVERABLE_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(done)
      if (goTo) router.replace(goTo, { scroll: false })
    }
    // The address may stay the same (the last item in the queue): load the page again either way.
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

/**
 * The team's decision on a hand-in ("Konnected team daily work" mockup, Deliverables): tick the
 * three checks, then release it to the company; or ask the student for more with a note the
 * student sees (templates fill it in). The server checks the team member and the rules again.
 */
export function DeliverableActions({
  deliverableId,
  company,
  student,
  paid,
  queueHref,
}: {
  deliverableId: number
  company: string
  student: string
  paid: boolean
  queueHref: string
}) {
  const t = useTranslations('TeamDeliverables')
  const te = useTranslations('Deliverables.errors')
  const id = useId()
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const release = useDecision(
    releaseAction,
    paid ? t('releasedToastPaid', { company }) : t('releasedToast', { company }),
    queueHref,
  )
  const back = useDecision(returnAction, t('returnedToast', { student }), queueHref)
  const busy = release.pending || back.pending
  const allTicked = CHECKS.every((c) => ticked.has(c))
  const error =
    release.state.status === 'error'
      ? release.state.error
      : back.state.status === 'error'
        ? back.state.error
        : null

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-1">
        <legend className="mb-1 text-[0.9rem] font-semibold">{t('checksTitle')}</legend>
        {CHECKS.map((check) => (
          <div key={check} className="flex min-h-11 items-start gap-3 py-1.5">
            <Checkbox
              id={`${id}-${check}`}
              className="mt-0.5"
              checked={ticked.has(check)}
              onCheckedChange={(value) =>
                setTicked((all) => {
                  const next = new Set(all)
                  if (value === true) next.add(check)
                  else next.delete(check)
                  return next
                })
              }
            />
            <Label htmlFor={`${id}-${check}`} className="font-normal">
              {t(`checks.${check}`)}
            </Label>
          </div>
        ))}
        {!allTicked && <p className="text-[0.82rem] text-muted-foreground">{t('checksHint')}</p>}
      </fieldset>
      <p className="text-[0.88rem] text-muted-foreground">{t('seesNothing', { company })}</p>

      {error && (
        <Banner tone="bad" role="alert">
          <p>{te(error)}</p>
        </Banner>
      )}

      <div className="flex flex-wrap gap-2.5">
        <form action={release.run}>
          <input type="hidden" name="id" value={deliverableId} />
          <Button
            type="submit"
            disabled={busy || !allTicked}
            aria-busy={release.pending || undefined}
          >
            {release.pending && (
              <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
            )}
            {t('release', { company })}
          </Button>
        </form>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={asking}
          aria-controls={`${id}-more`}
          onClick={() => setAsking((v) => !v)}
        >
          {t('askMore')}
        </Button>
      </div>

      {asking && (
        <form
          id={`${id}-more`}
          action={back.run}
          className="grid gap-3 rounded-item bg-surface-2 p-3.5"
        >
          <input type="hidden" name="id" value={deliverableId} />
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('templatesLabel')}>
            {TEMPLATES.map((key) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setNote(t(`templates.${key}.text`))}
              >
                {t(`templates.${key}.label`)}
              </Button>
            ))}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('moreLabel')}</Label>
            <Textarea
              id={`${id}-note`}
              name="returnNote"
              rows={3}
              required
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-describedby={`${id}-hint`}
            />
            <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('moreHint')}
            </p>
          </div>
          <div>
            <Button type="submit" size="sm" disabled={busy} aria-busy={back.pending || undefined}>
              {back.pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('sendToStudent')}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
