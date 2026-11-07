'use client'

import { LoaderCircleIcon, PlayIcon, PlusIcon, XIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type FormEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { recordKickoffAction, saveNoteAction, startWorkAction } from '@/lib/kickoff/actions'
import { KICKOFF_IDLE, KICKOFF_LIMITS, type KickoffState } from '@/lib/kickoff/fields'

/*
 * The team's kick-off form, the "Start the project" button and the latest note to the company, on
 * the team's project page ("Final pass" mockup, team project page, state "Matched"). The server
 * checks the team member and every rule again; the acting user never comes from the form.
 */

type Action = (state: KickoffState, form: FormData) => Promise<KickoffState>

/** Run one action; on success a toast and a fresh page, on error the message stays. */
function useKickoffAction(action: Action, done: string, onDone?: () => void) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, KICKOFF_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(done)
      onDone?.()
    }
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  // Submit without React's automatic form reset, so what was typed stays after an error.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    startTransition(() => run(data))
  }
  return { state, pending, onSubmit }
}

function Submit({
  pending,
  children,
  icon,
}: {
  pending: boolean
  children: ReactNode
  icon?: ReactNode
}) {
  return (
    <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
      {pending ? (
        <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
      ) : (
        icon
      )}
      {children}
    </Button>
  )
}

function ErrorLine({ state }: { state: KickoffState }) {
  const te = useTranslations('Kickoff.errors')
  if (state.status !== 'error') return null
  return (
    <Banner tone="bad" role="alert">
      <p>{te(state.error)}</p>
    </Banner>
  )
}

export type KickoffFormValues = {
  scope: string
  delivery: string
  start: string
  due: string
  checkIns: string[]
  contactId: number | null
}

/**
 * Record or correct the kick-off: agreed scope, start and due dates, check-in dates, the Konnected
 * contact and how to deliver. Opened by a button once recorded; open from the start before that.
 */
export function KickoffForm({
  projectId,
  values,
  members,
  recorded,
  locked,
}: {
  projectId: number
  values: KickoffFormValues
  members: { id: number; name: string }[]
  /** The kick-off is recorded already: the form opens with "Change the kick-off". */
  recorded: boolean
  /** A student agreement is made from it: the server refuses a change until it is withdrawn. */
  locked: boolean
}) {
  const t = useTranslations('Kickoff')
  const uid = useId()
  const [open, setOpen] = useState(!recorded)
  const [checkIns, setCheckIns] = useState<{ key: number; value: string }[]>(() =>
    (values.checkIns.length ? values.checkIns : ['']).map((value, key) => ({ key, value })),
  )
  const next = useRef(checkIns.length)
  const { state, pending, onSubmit } = useKickoffAction(
    recordKickoffAction,
    recorded ? t('changedToast') : t('recordedToast'),
    () => setOpen(false),
  )

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={false}
          aria-controls={`${uid}-form`}
          onClick={() => setOpen(true)}
          disabled={locked}
        >
          {t('change')}
        </Button>
        {locked && <p className="mt-2 text-[0.85rem] text-muted-foreground">{t('lockedHint')}</p>}
      </div>
    )
  }

  return (
    <form id={`${uid}-form`} onSubmit={onSubmit} className="grid gap-4" noValidate>
      <input type="hidden" name="id" value={projectId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-scope`}>{t('scope')}</Label>
        <Textarea
          id={`${uid}-scope`}
          name="scope"
          rows={4}
          required
          maxLength={KICKOFF_LIMITS.scope}
          defaultValue={values.scope}
          aria-describedby={`${uid}-scope-hint`}
        />
        <p id={`${uid}-scope-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('scopeHint')}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${uid}-start`}>{t('start')}</Label>
          <Input
            id={`${uid}-start`}
            name="start"
            type="date"
            required
            defaultValue={values.start}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${uid}-due`}>{t('due')}</Label>
          <Input id={`${uid}-due`} name="due" type="date" required defaultValue={values.due} />
        </div>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid min-w-0 content-start gap-1.5">
          <Label htmlFor={`${uid}-contact`}>{t('contact')}</Label>
          <Select
            name="contact"
            defaultValue={values.contactId ? String(values.contactId) : undefined}
          >
            <SelectTrigger id={`${uid}-contact`}>
              <SelectValue placeholder={t('contactPick')} />
            </SelectTrigger>
            <SelectContent>
              {members.map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div
          role="group"
          aria-labelledby={`${uid}-checkins`}
          className="grid min-w-0 content-start gap-1.5"
        >
          <p id={`${uid}-checkins`} className="text-[0.9rem] leading-snug font-semibold">
            {t('checkIns')}
          </p>
          {checkIns.map((c, i) => (
            <div key={c.key} className="flex items-center gap-2">
              <Input
                name="checkIn"
                type="date"
                defaultValue={c.value}
                aria-label={t('checkInN', { n: i + 1 })}
                className="min-w-0 flex-1"
              />
              {checkIns.length > 1 && (
                <Button
                  type="button"
                  variant="text"
                  size="icon"
                  aria-label={t('removeCheckIn', { n: i + 1 })}
                  onClick={() => setCheckIns((all) => all.filter((x) => x.key !== c.key))}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              )}
            </div>
          ))}
          {checkIns.length < KICKOFF_LIMITS.checkIns && (
            <div>
              <Button
                type="button"
                variant="text"
                size="sm"
                onClick={() =>
                  setCheckIns((all) => [...all, { key: (next.current += 1), value: '' }])
                }
              >
                <PlusIcon aria-hidden="true" />
                {t('addCheckIn')}
              </Button>
            </div>
          )}
          <p className="text-[0.82rem] text-muted-foreground">{t('checkInsHint')}</p>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-delivery`}>{t('delivery')}</Label>
        <Textarea
          id={`${uid}-delivery`}
          name="delivery"
          rows={2}
          required
          maxLength={KICKOFF_LIMITS.delivery}
          defaultValue={values.delivery}
          aria-describedby={`${uid}-delivery-hint`}
        />
        <p id={`${uid}-delivery-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('deliveryHint')}
        </p>
      </div>
      <ErrorLine state={state} />
      <div className="flex flex-wrap gap-2.5">
        <Submit pending={pending}>{recorded ? t('save') : t('record')}</Submit>
        {recorded && (
          <Button type="button" size="sm" variant="text" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  )
}

/** "Start the project": matched to in progress, once the student agreement is signed. */
export function StartWorkButton({
  projectId,
  ready,
  children,
}: {
  projectId: number
  ready: boolean
  /** More buttons on the same row (Open Agreements). */
  children?: ReactNode
}) {
  const t = useTranslations('Kickoff')
  const { state, pending, onSubmit } = useKickoffAction(startWorkAction, t('startedToast'))
  return (
    <form onSubmit={onSubmit} className="grid gap-2">
      <input type="hidden" name="id" value={projectId} />
      <div className="flex flex-wrap gap-2.5">
        <Button
          type="submit"
          size="sm"
          disabled={pending || !ready}
          aria-busy={pending || undefined}
          aria-describedby={ready ? undefined : `start-${projectId}-hint`}
        >
          {pending ? (
            <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
          ) : (
            <PlayIcon aria-hidden="true" />
          )}
          {t('start_work')}
        </Button>
        {children}
      </div>
      {!ready && (
        <p id={`start-${projectId}-hint`} className="text-[0.85rem] text-muted-foreground">
          {t('startHint')}
        </p>
      )}
      <ErrorLine state={state} />
    </form>
  )
}

/** The latest note to the company: one short text the company sees on its project page. */
export function NoteForm({
  projectId,
  note,
  company,
}: {
  projectId: number
  note: string
  company: string
}) {
  const t = useTranslations('TeamNote')
  const uid = useId()
  const { state, pending, onSubmit } = useKickoffAction(
    saveNoteAction,
    t('savedToast', { company }),
  )
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <input type="hidden" name="id" value={projectId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-note`}>{t('label')}</Label>
        <Textarea
          id={`${uid}-note`}
          name="note"
          rows={3}
          maxLength={1000}
          defaultValue={note}
          aria-describedby={`${uid}-hint`}
        />
        <p id={`${uid}-hint`} className="text-[0.82rem] text-muted-foreground">
          {t('hint')}
        </p>
      </div>
      <ErrorLine state={state} />
      <div>
        <Submit pending={pending}>{t('save')}</Submit>
      </div>
    </form>
  )
}
