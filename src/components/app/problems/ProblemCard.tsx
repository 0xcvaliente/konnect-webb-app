'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { reportProblemAction } from '@/lib/problems/actions'
import { PROBLEM_IDLE, PROBLEM_KINDS, PROBLEM_NOTE_MAX } from '@/lib/problems/fields'

/**
 * "Need more time?" ("Final pass" mockup, the student's application page): tell Konnected "I need
 * more time" or "I can't finish", with a note only the team reads. The company is told the new
 * plan, never the note. The server takes the student from the session and checks the match.
 */
export function ProblemCard({ projectId, company }: { projectId: number; company: string }) {
  const t = useTranslations('StudentProblem')
  const te = useTranslations('Problems.errors')
  const id = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, run, pending] = useActionState(reportProblemAction, PROBLEM_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    // After a send the page reloads without this card: the report waits for the team.
    if (state.status === 'done') toast(t('sent'))
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  return (
    <Card className="gap-3">
      <div className="grid gap-1">
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-[0.9rem] text-muted-foreground">{t('body', { company })}</p>
      </div>
      {!open ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          aria-expanded={false}
          aria-controls={`${id}-form`}
          onClick={() => setOpen(true)}
        >
          {t('open')}
        </Button>
      ) : (
        <form id={`${id}-form`} action={run} className="grid gap-3">
          <input type="hidden" name="projectId" value={projectId} />
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-[0.9rem] font-semibold">{t('legend')}</legend>
            <RadioGroup
              name="kind"
              defaultValue="more_time"
              aria-label={t('legend')}
              className="grid gap-0"
            >
              {PROBLEM_KINDS.map((kind) => (
                <div key={kind} className="flex min-h-11 items-center gap-3">
                  <RadioGroupItem id={`${id}-${kind}`} value={kind} />
                  <Label htmlFor={`${id}-${kind}`} className="font-normal">
                    {t(`kind.${kind}`)}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-note`}>{t('noteLabel')}</Label>
            <Textarea
              id={`${id}-note`}
              name="note"
              rows={3}
              required
              maxLength={PROBLEM_NOTE_MAX}
              aria-describedby={`${id}-hint`}
            />
            <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('noteHint', { company })}
            </p>
          </div>
          {state.status === 'error' && (
            <Banner tone="bad" role="alert">
              <p>{te(state.error)}</p>
            </Banner>
          )}
          <div className="flex flex-wrap gap-2.5">
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
              {pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('send')}
            </Button>
            <Button type="button" size="sm" variant="text" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}
