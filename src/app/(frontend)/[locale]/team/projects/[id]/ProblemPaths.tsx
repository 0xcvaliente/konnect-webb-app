'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { PROBLEM_IDLE, type ProblemState, REASON_MAX } from '@/lib/problems/fields'
import {
  askChangesAction,
  closeProjectAction,
  endMatchAction,
  handledAction,
  moveDueDateAction,
  reopenAction,
} from '@/lib/team/projectActions'

type Action = (state: ProblemState, form: FormData) => Promise<ProblemState>

/** Run one decision; on success a toast and a fresh page, on error the message stays. */
function useDecision(action: Action, done: string) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, PROBLEM_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') toast(done)
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

function Submit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

function ErrorLine({ state }: { state: ProblemState }) {
  const te = useTranslations('Problems.errors')
  if (state.status !== 'error') return null
  return (
    <Banner tone="bad" role="alert">
      <p>{te(state.error)}</p>
    </Banner>
  )
}

function DateField({
  id,
  name,
  label,
  hint,
  value,
  min,
}: {
  id: string
  name: string
  label: string
  hint?: string
  value: string
  min: string
}) {
  return (
    <div className="grid max-w-[260px] gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type="date"
        required
        min={min}
        defaultValue={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function TextField({
  id,
  name,
  label,
  hint,
  required = false,
  defaultValue,
}: {
  id: string
  name: string
  label: string
  hint?: string
  required?: boolean
  defaultValue?: string
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name={name}
        rows={3}
        required={required}
        maxLength={REASON_MAX}
        defaultValue={defaultValue}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

const box = 'grid gap-3 rounded-item bg-surface-2 p-3.5'

/**
 * The team's choices on a project ("Final pass" mockup, team project page): for a running project
 * (with or without the student's report) move the due date, match again (end the match and reopen
 * applications) or close without delivery, and mark a report handled; for a project nobody was
 * selected for, reopen applications, ask the company for changes or close without a match. Each
 * opens its own small form; the server checks the team member and every rule again.
 */
export function ProblemPaths({
  mode,
  projectId,
  reportId,
  student,
  company,
  today,
  dueDay,
  closeDay,
}: {
  mode: 'running' | 'noMatch'
  projectId: number
  /** The open report, when the student wrote one. */
  reportId?: number | null
  student: string
  company: string
  /** Today in Oslo (`YYYY-MM-DD`): the earliest day the date fields take. */
  today: string
  /** Suggested days for the forms. */
  dueDay: string
  closeDay: string
}) {
  const t = useTranslations('TeamProject')
  const id = useId()
  const [open, setOpen] = useState<string | null>(null)
  const move = useDecision(moveDueDateAction, t('toast.dateMoved'))
  const end = useDecision(endMatchAction, t('toast.ended'))
  const close = useDecision(closeProjectAction, t('toast.closed'))
  const reopen = useDecision(reopenAction, t('toast.reopened'))
  const ask = useDecision(askChangesAction, t('toast.changesSent', { company }))
  const handled = useDecision(handledAction, t('toast.handled'))

  const toggle = (key: string) => setOpen((now) => (now === key ? null : key))
  const button = (key: string, label: string, variant: 'main' | 'secondary' | 'text') => (
    <Button
      type="button"
      variant={variant}
      aria-expanded={open === key}
      aria-controls={`${id}-${key}`}
      onClick={() => toggle(key)}
    >
      {label}
    </Button>
  )

  if (mode === 'noMatch') {
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2.5">
          {button('reopen', t('reopen'), 'main')}
          {button('ask', t('askChanges'), 'secondary')}
          {button('close', t('closeNoMatch'), 'text')}
        </div>
        {open === 'reopen' && (
          <form id={`${id}-reopen`} action={reopen.run} className={box}>
            <input type="hidden" name="id" value={projectId} />
            <DateField
              id={`${id}-rd`}
              name="date"
              label={t('newClosing')}
              value={closeDay}
              min={today}
            />
            <ErrorLine state={reopen.state} />
            <div>
              <Submit pending={reopen.pending}>{t('reopenButton')}</Submit>
            </div>
          </form>
        )}
        {open === 'ask' && (
          <form id={`${id}-ask`} action={ask.run} className={box}>
            <input type="hidden" name="id" value={projectId} />
            <TextField
              id={`${id}-an`}
              name="note"
              label={t('changesLabel')}
              hint={t('changesHint')}
              required
            />
            <ErrorLine state={ask.state} />
            <div>
              <Submit pending={ask.pending}>{t('sendChanges')}</Submit>
            </div>
          </form>
        )}
        {open === 'close' && (
          <form id={`${id}-close`} action={close.run} className={box}>
            <input type="hidden" name="id" value={projectId} />
            <TextField
              id={`${id}-cr`}
              name="reason"
              label={t('reason')}
              hint={t('reasonCompanyHint')}
              required
            />
            <ErrorLine state={close.state} />
            <div>
              <Submit pending={close.pending}>{t('closeButton')}</Submit>
            </div>
          </form>
        )}
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2.5">
        {button('move', t('moveDate'), 'main')}
        {button('end', t('matchAgain'), 'secondary')}
        {button('close', t('closeNoDelivery'), 'text')}
        {reportId ? button('handled', t('handled'), 'text') : null}
      </div>
      {open === 'move' && (
        <form id={`${id}-move`} action={move.run} className={box}>
          <input type="hidden" name="id" value={projectId} />
          <DateField
            id={`${id}-nd`}
            name="date"
            label={t('newDue')}
            hint={t('newDueHint')}
            value={dueDay}
            min={today}
          />
          <TextField id={`${id}-mn`} name="note" label={t('logNote')} hint={t('logNoteHint')} />
          <ErrorLine state={move.state} />
          <div>
            <Submit pending={move.pending}>{t('saveDate')}</Submit>
          </div>
        </form>
      )}
      {open === 'end' && (
        <form id={`${id}-end`} action={end.run} className={box}>
          <input type="hidden" name="id" value={projectId} />
          <p className="font-semibold">{t('endConfirm', { student })}</p>
          <ul className="grid list-disc gap-1 pl-5 text-[0.88rem] text-muted-foreground">
            <li>{t('end1', { student })}</li>
            <li>{t('end2', { student, company })}</li>
            <li>{t('end3')}</li>
          </ul>
          <DateField
            id={`${id}-ec`}
            name="date"
            label={t('closesLabel')}
            value={closeDay}
            min={today}
          />
          <TextField id={`${id}-en`} name="note" label={t('logNote')} hint={t('logNoteHint')} />
          <ErrorLine state={end.state} />
          <div>
            <Submit pending={end.pending}>{t('endButton')}</Submit>
          </div>
        </form>
      )}
      {open === 'close' && (
        <form id={`${id}-close`} action={close.run} className={box}>
          <input type="hidden" name="id" value={projectId} />
          <TextField
            id={`${id}-cd`}
            name="reason"
            label={t('reason')}
            hint={t('reasonBothHint')}
            required
          />
          <p className="text-[0.85rem] text-muted-foreground">{t('caseByCase')}</p>
          <ErrorLine state={close.state} />
          <div>
            <Submit pending={close.pending}>{t('closeButton')}</Submit>
          </div>
        </form>
      )}
      {open === 'handled' && reportId && (
        <form id={`${id}-handled`} action={handled.run} className={box}>
          <input type="hidden" name="reportId" value={reportId} />
          <p className="text-[0.88rem] text-muted-foreground">{t('handledHint')}</p>
          <TextField id={`${id}-hn`} name="note" label={t('logNote')} hint={t('logNoteHint')} />
          <ErrorLine state={handled.state} />
          <div>
            <Submit pending={handled.pending}>{t('handledButton')}</Submit>
          </div>
        </form>
      )}
    </div>
  )
}
