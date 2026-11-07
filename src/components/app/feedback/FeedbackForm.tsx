'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { sendFeedbackAction } from '@/lib/feedback/actions'
import { FEEDBACK_IDLE, FEEDBACK_TEXT_MAX, RATING_MAX, RATING_MIN } from '@/lib/feedback/fields'

const RATINGS = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i)

/**
 * The short form after a project ("Final pass" mockup, "Feedback after a project"): overall 1 to
 * 5, what went well, what could be better, and whether they would do it again. Sent once; only
 * Konnected reads it. The server takes the author and side from the session.
 */
export function FeedbackForm({
  projectId,
  as,
  backHref,
}: {
  projectId: number
  as: 'student' | 'company'
  backHref: string
}) {
  const t = useTranslations('Feedback')
  const te = useTranslations('Feedback.errors')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(sendFeedbackAction, FEEDBACK_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(t('sentToast'))
      router.replace(backHref)
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  return (
    <Card className="gap-5">
      <form action={run} className="grid gap-5">
        <input type="hidden" name="projectId" value={projectId} />
        <fieldset className="grid gap-2" aria-describedby={`${id}-rating-hint`}>
          <legend className="mb-1 text-base font-semibold">{t('overall')}</legend>
          <div className="flex flex-wrap gap-2">
            {RATINGS.map((n) => (
              <label key={n} className="relative">
                <input
                  type="radio"
                  name="rating"
                  value={n}
                  required
                  className="peer sr-only"
                  aria-label={t('ratingLabel', { n })}
                />
                <span
                  aria-hidden="true"
                  className="grid size-11 cursor-pointer place-items-center rounded-full border-[1.5px] border-line bg-surface text-[0.95rem] font-semibold tabular-nums transition-colors peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary hover:bg-surface-2 peer-checked:hover:bg-primary"
                >
                  {n}
                </span>
              </label>
            ))}
          </div>
          <p id={`${id}-rating-hint`} className="text-[0.82rem] text-muted-foreground">
            {t('ratingHint')}
          </p>
        </fieldset>

        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-well`}>{t('wentWell')}</Label>
          <Textarea id={`${id}-well`} name="wentWell" rows={3} maxLength={FEEDBACK_TEXT_MAX} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-better`}>{t('better')}</Label>
          <Textarea
            id={`${id}-better`}
            name="couldBeBetter"
            rows={3}
            maxLength={FEEDBACK_TEXT_MAX}
            aria-describedby={`${id}-better-hint`}
          />
          <p id={`${id}-better-hint`} className="text-[0.82rem] text-muted-foreground">
            {as === 'student' ? t('betterHintStudent') : t('betterHintCompany')}
          </p>
        </div>
        <div className="flex min-h-11 items-start gap-3">
          <Checkbox id={`${id}-again`} name="again" className="mt-0.5" />
          <Label htmlFor={`${id}-again`} className="font-normal">
            {as === 'student' ? t('againStudent') : t('againCompany')}
          </Label>
        </div>

        {state.status === 'error' && (
          <Banner tone="bad" role="alert">
            <p>{te(state.error)}</p>
          </Banner>
        )}
        <div>
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending && (
              <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
            )}
            {t('send')}
          </Button>
        </div>
      </form>
    </Card>
  )
}
