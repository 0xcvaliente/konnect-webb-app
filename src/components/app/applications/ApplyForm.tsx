'use client'

import { LoaderCircleIcon, SendIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { applyAction } from '@/lib/applications/actions'
import { APPLY_IDLE, NOTE_MAX } from '@/lib/applications/fields'

/**
 * The apply box's form on a project page: a short note on why the student fits, then send. The
 * server decides everything (the student comes from the session, the rules from the collection
 * hook); this form only asks and reports. After sending, the page reloads into its "applied"
 * state.
 */
export function ApplyForm({ projectId }: { projectId: number }) {
  const t = useTranslations('Apply')
  const id = useId()
  const router = useRouter()
  const [state, run, pending] = useActionState(applyAction, APPLY_IDLE)
  const seen = useRef<number | undefined>(undefined)
  // Controlled, so an answer from the server (an error) does not clear what was typed.
  const [note, setNote] = useState('')

  useEffect(() => {
    if (state.status !== 'done' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    toast(t('sentToast'))
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result

  const error = state.status === 'error' ? state.error : null
  const noteError = error === 'note_required' || error === 'note_too_long'
  const length = note.trim().length

  return (
    <form action={run} className="grid gap-3" noValidate>
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-note`}>{t('noteLabel')}</Label>
        <Textarea
          id={`${id}-note`}
          name="note"
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
          maxLength={NOTE_MAX}
          aria-invalid={noteError || undefined}
          aria-describedby={`${id}-hint ${id}-count${error ? ` ${id}-error` : ''}`}
        />
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('noteHint')}
        </p>
        <p
          id={`${id}-count`}
          className="text-[0.78rem] text-muted-foreground [font-variant-numeric:tabular-nums]"
        >
          {t('noteCount', { count: length, max: NOTE_MAX })}
        </p>
      </div>
      {error && (
        <Banner tone="bad" role="alert" id={`${id}-error`}>
          <p>{t(`errors.${error}`, { max: NOTE_MAX })}</p>
        </Banner>
      )}
      <Button type="submit" className="w-full" disabled={pending} aria-busy={pending || undefined}>
        {pending ? (
          <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
        ) : (
          <SendIcon aria-hidden="true" />
        )}
        {pending ? t('sending') : t('submit')}
      </Button>
    </form>
  )
}
