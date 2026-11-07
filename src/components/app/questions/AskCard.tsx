'use client'

import { LoaderCircleIcon, MessageCircleQuestionIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { answerRelayAction, askQuestionAction } from '@/lib/questions/actions'
import type { AskerQuestions, ReceivedRelay } from '@/lib/questions/asker'
import { ANSWER_MAX, QUESTION_IDLE, QUESTION_MAX, type QuestionState } from '@/lib/questions/fields'

/** Run a toast and refresh the page once per result of a form's action. */
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

/** A day (`YYYY-MM-DD`) or a moment (ISO) in words, in Oslo. */
function useDay() {
  const format = useFormatter()
  return (value: string) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T12:00:00.000Z`)
      : new Date(value)
    return format.dateTime(date, { dateStyle: 'medium', timeZone: 'Europe/Oslo' })
  }
}

/** One question Konnected passed on: answer it once. */
function RelayItem({ relay }: { relay: ReceivedRelay }) {
  const t = useTranslations('AskKonnected')
  const te = useTranslations('AskKonnected.errors')
  const day = useDay()
  const id = useId()
  const [state, run, pending] = useActionState(answerRelayAction, QUESTION_IDLE)
  useResult(state, () => toast(t('relaySent')))
  return (
    <li className="grid gap-2 rounded-item bg-surface-2 px-3.5 py-3">
      <p className="text-[0.82rem] text-muted-foreground">
        {t('relayFrom', { date: day(relay.createdAt) })}
      </p>
      <p className="font-semibold [overflow-wrap:anywhere] whitespace-pre-line">{relay.body}</p>
      {relay.answer ? (
        <div className="grid gap-0.5">
          <p className="text-[0.82rem] text-muted-foreground">
            {t('relayAnswered', { date: day(relay.answeredAt ?? relay.createdAt) })}
          </p>
          <p className="text-[0.9rem] [overflow-wrap:anywhere] whitespace-pre-line">
            {relay.answer}
          </p>
        </div>
      ) : (
        <form action={run} className="grid gap-2">
          <input type="hidden" name="id" value={relay.id} />
          <Label htmlFor={`${id}-answer`}>{t('relayLabel')}</Label>
          <Textarea
            id={`${id}-answer`}
            name="answer"
            rows={2}
            required
            maxLength={ANSWER_MAX}
            aria-describedby={`${id}-hint`}
            className="bg-surface"
          />
          <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
            {t('relayHint')}
          </p>
          {state.status === 'error' && (
            <Banner tone="bad" role="alert">
              <p>{te(state.error)}</p>
            </Banner>
          )}
          <div>
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
              {pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('relaySend')}
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}

/**
 * "Ask Konnected" ("Final pass" mockup, the student's application page and the company's project
 * page): a question to the Konnected team about this project, not a message to the other side.
 * The asker's earlier questions with Konnected's answers, the questions Konnected passed on to
 * them, and the form. The server takes the asker from the session and checks the application or
 * project is theirs; only they and the team read what is here.
 */
export function AskCard({
  as,
  targetId,
  company,
  questions,
}: {
  as: 'student' | 'company'
  /** The student's application id, or the company's project id. */
  targetId: number
  company: string
  questions: AskerQuestions
}) {
  const t = useTranslations('AskKonnected')
  const te = useTranslations('AskKonnected.errors')
  const day = useDay()
  const id = useId()
  const [state, run, pending] = useActionState(askQuestionAction, QUESTION_IDLE)
  // A new form after each question sent, so the text field starts empty again.
  const [round, setRound] = useState(0)
  useResult(state, () => {
    toast(t('sent'))
    setRound((n) => n + 1)
  })

  return (
    <Card className="gap-4" aria-labelledby={`${id}-title`}>
      <div className="grid gap-1">
        <CardTitle id={`${id}-title`} className="flex items-center gap-2">
          <MessageCircleQuestionIcon aria-hidden="true" className="size-[18px] text-primary" />
          {t('title')}
        </CardTitle>
        <p className="text-[0.9rem] text-muted-foreground">
          {as === 'student' ? t('bodyStudent', { company }) : t('bodyCompany')}
        </p>
      </div>

      {questions.relays.length > 0 && (
        <section aria-labelledby={`${id}-relays`} className="grid gap-2">
          <h3 id={`${id}-relays`} className="text-[0.9rem] font-semibold">
            {t('relaysTitle')}
          </h3>
          <ul className="grid gap-2">
            {questions.relays.map((relay) => (
              <RelayItem key={relay.id} relay={relay} />
            ))}
          </ul>
        </section>
      )}

      {questions.asked.length > 0 && (
        <section aria-labelledby={`${id}-asked`} className="grid gap-2">
          <h3 id={`${id}-asked`} className="sr-only">
            {t('askedTitle')}
          </h3>
          <ul className="grid">
            {questions.asked.map((q) => (
              <li
                key={q.id}
                className="grid gap-1 border-b border-line py-3 first:pt-0 last:border-b-0"
              >
                <p className="font-semibold [overflow-wrap:anywhere] whitespace-pre-line">
                  {q.body}
                </p>
                <p className="text-[0.82rem] text-muted-foreground">
                  {t('askedOn', { date: day(q.createdAt) })}
                </p>
                {q.answer ? (
                  <div className="mt-1 grid gap-0.5 border-l-[3px] border-line pl-3">
                    <p className="text-[0.82rem] text-muted-foreground">
                      {q.answeredByName
                        ? t('answered', {
                            name: q.answeredByName,
                            date: day(q.answeredAt ?? q.createdAt),
                          })
                        : t('answeredTeam', { date: day(q.answeredAt ?? q.createdAt) })}
                    </p>
                    <p className="text-[0.92rem] [overflow-wrap:anywhere] whitespace-pre-line">
                      {q.answer}
                    </p>
                  </div>
                ) : (
                  <p className="text-[0.85rem] font-medium text-[color-mix(in_srgb,var(--warn)_62%,var(--ink))]">
                    {t('waiting', { date: day(q.answerBy) })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {questions.canAsk ? (
        <form key={round} action={run} className="grid gap-2.5">
          <input
            type="hidden"
            name={as === 'student' ? 'applicationId' : 'projectId'}
            value={targetId}
          />
          <Label htmlFor={`${id}-body`}>{t('label')}</Label>
          <Textarea
            id={`${id}-body`}
            name="body"
            rows={3}
            required
            maxLength={QUESTION_MAX}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
            {t('hint')}
          </p>
          {state.status === 'error' && (
            <Banner tone="bad" role="alert">
              <p>{te(state.error)}</p>
            </Banner>
          )}
          <div>
            <Button
              type="submit"
              variant="secondary"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('send')}
            </Button>
          </div>
        </form>
      ) : (
        <Banner>
          <p className="text-[0.88rem]">{t('limit')}</p>
        </Banner>
      )}
    </Card>
  )
}
