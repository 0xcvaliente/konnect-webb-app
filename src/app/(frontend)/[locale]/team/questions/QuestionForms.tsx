'use client'

import { LoaderCircleIcon, Trash2Icon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { TextField } from '@/components/app/AuthForm'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import {
  addSavedAnswerAction,
  answerQuestionAction,
  relayQuestionAction,
  removeSavedAnswerAction,
} from '@/lib/questions/actions'
import {
  ANSWER_MAX,
  QUESTION_IDLE,
  QUESTION_MAX,
  type QuestionSide,
  type QuestionState,
  SAVED_TITLE_MAX,
} from '@/lib/questions/fields'

/** Toast and refresh once per result. */
function useResult(state: QuestionState, onDone: () => void) {
  const router = useRouter()
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      onDone()
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
}

function ErrorBanner({ state }: { state: QuestionState }) {
  const te = useTranslations('TeamQuestions.errors')
  if (state.status !== 'error') return null
  return (
    <Banner tone="bad" role="alert">
      <p>{te(state.error)}</p>
    </Banner>
  )
}

function Submit({ pending, children }: { pending: boolean; children: React.ReactNode }) {
  return (
    <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

/**
 * The team's answer ("Konnected team daily work" mockup, Questions): typed, or started from a
 * saved answer and changed to fit. Emailed to the asker and kept with the project.
 */
export function AnswerForm({
  questionId,
  asker,
  side,
  saved,
}: {
  questionId: number
  asker: string
  side: QuestionSide
  saved: { id: number; title: string; body: string }[]
}) {
  const t = useTranslations('TeamQuestions')
  const id = useId()
  const [state, run, pending] = useActionState(answerQuestionAction, QUESTION_IDLE)
  // Controlled, so a saved answer can fill it and what was typed stays after a refused send.
  const [answer, setAnswer] = useState('')
  useResult(state, () => toast(t('sent', { asker })))
  return (
    <form action={run} className="grid gap-3">
      <input type="hidden" name="id" value={questionId} />
      {saved.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-saved`}>{t('savedLabel')}</Label>
          <Select
            onValueChange={(value) => {
              const pick = saved.find((s) => String(s.id) === value)
              if (pick) setAnswer(pick.body)
            }}
          >
            <SelectTrigger id={`${id}-saved`} className="w-full sm:max-w-sm">
              <SelectValue placeholder={t('savedNone')} />
            </SelectTrigger>
            <SelectContent>
              {saved.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[0.82rem] text-muted-foreground">{t('savedHint')}</p>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-answer`}>{t('answerLabel')}</Label>
        <Textarea
          id={`${id}-answer`}
          name="answer"
          rows={4}
          required
          maxLength={ANSWER_MAX}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {t(`answerHint.${side}`, { asker })}
        </p>
      </div>
      <ErrorBanner state={state} />
      <div>
        <Submit pending={pending}>{t('send')}</Submit>
      </div>
    </form>
  )
}

/**
 * Pass the question on to the other side, in the team member's own words. The other side gets an
 * email and answers once in the app; only the team reads that answer.
 */
export function RelayForm({ questionId, to }: { questionId: number; to: QuestionSide }) {
  const t = useTranslations('TeamQuestions')
  const id = useId()
  const [state, run, pending] = useActionState(relayQuestionAction, QUESTION_IDLE)
  const [open, setOpen] = useState(false)
  const [round, setRound] = useState(0)
  useResult(state, () => {
    toast(t('relaySent'))
    setOpen(false)
    setRound((n) => n + 1)
  })
  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={false}
          aria-controls={`${id}-form`}
          onClick={() => setOpen(true)}
        >
          {t(`relayTo.${to}`)}
        </Button>
      </div>
    )
  }
  return (
    <form key={round} id={`${id}-form`} action={run} className="grid gap-3">
      <input type="hidden" name="id" value={questionId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-body`}>{t('relayLabel')}</Label>
        <Textarea
          id={`${id}-body`}
          name="body"
          rows={3}
          required
          maxLength={QUESTION_MAX}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {t(`relayHint.${to}`)}
        </p>
      </div>
      <ErrorBanner state={state} />
      <div className="flex flex-wrap gap-2.5">
        <Submit pending={pending}>{t('relaySend')}</Submit>
        <Button type="button" variant="text" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

/** Keep an answer for later. */
export function SavedAnswerForm() {
  const t = useTranslations('TeamQuestions')
  const id = useId()
  const [state, run, pending] = useActionState(addSavedAnswerAction, QUESTION_IDLE)
  const [round, setRound] = useState(0)
  useResult(state, () => {
    toast(t('savedAdded'))
    setRound((n) => n + 1)
  })
  return (
    <form key={round} action={run} className="grid gap-3">
      <TextField
        id={`${id}-title`}
        name="title"
        label={t('savedTitleLabel')}
        hint={t('savedTitleHint')}
        required
        maxLength={SAVED_TITLE_MAX}
        autoComplete="off"
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-body`}>{t('savedBodyLabel')}</Label>
        <Textarea id={`${id}-body`} name="body" rows={3} required maxLength={ANSWER_MAX} />
      </div>
      <ErrorBanner state={state} />
      <div>
        <Submit pending={pending}>{t('savedAdd')}</Submit>
      </div>
    </form>
  )
}

/** Remove one saved answer. */
export function RemoveSavedAnswer({ id: savedId, title }: { id: number; title: string }) {
  const t = useTranslations('TeamQuestions')
  const [state, run, pending] = useActionState(removeSavedAnswerAction, QUESTION_IDLE)
  useResult(state, () => toast(t('savedRemoved')))
  return (
    <form action={run}>
      <input type="hidden" name="id" value={savedId} />
      <Button
        type="submit"
        size="sm"
        variant="text"
        disabled={pending}
        aria-busy={pending || undefined}
      >
        <Trash2Icon aria-hidden="true" className="size-4" />
        {t('savedRemove')}
        <span className="sr-only">: {title}</span>
      </Button>
    </form>
  )
}
