'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type FormEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useEffect,
  useId,
  useRef,
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
import {
  type PoolCollection,
  REASSIGN_NOTE_MAX,
  TEAM_IDLE,
  type TeamFormState,
} from '@/lib/team/memberFields'
import { awayAction, reassignAction, takeAction } from '@/lib/team/ownershipActions'

/*
 * The team workspace forms (Today, the Team page, a project's owner): take an item from the
 * shared pool, move a company or a project to another team member with a note, and set away days
 * and a cover. The server checks the team member and every rule again; the acting user never
 * comes from the form.
 */

type Action = (state: TeamFormState, form: FormData) => Promise<TeamFormState>
export type MemberOption = { id: number; name: string }

/** Run one action; on success a toast and a fresh page, on error the message stays. */
function useTeamAction(action: Action, done: string) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, TEAM_IDLE)
  const seen = useRef<number | undefined>(undefined)
  const lastForm = useRef<HTMLFormElement | null>(null)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(done)
      lastForm.current?.reset()
    }
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  // Submit without React's automatic form reset, so what was typed stays after an error.
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    lastForm.current = event.currentTarget
    const data = new FormData(event.currentTarget)
    startTransition(() => run(data))
  }
  return { state, run, pending, onSubmit }
}

function Submit({
  pending,
  children,
  variant = 'main',
}: {
  pending: boolean
  children: ReactNode
  variant?: 'main' | 'secondary' | 'normal'
}) {
  return (
    <Button
      type="submit"
      size="sm"
      variant={variant}
      disabled={pending}
      aria-busy={pending || undefined}
    >
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

function ErrorLine({ state }: { state: TeamFormState }) {
  const te = useTranslations('TeamToday.errors')
  if (state.status !== 'error') return null
  return (
    <Banner tone="bad" role="alert" className="w-full">
      <p>{te(state.error)}</p>
    </Banner>
  )
}

/** "Take it": one button per shared-pool item. */
export function TakeButton({
  collection,
  id,
  label,
}: {
  collection: PoolCollection
  id: number
  /** What is taken, for screen readers ("Take it: Skarv Robotics AS"). */
  label: string
}) {
  const t = useTranslations('TeamToday')
  const { state, run, pending } = useTeamAction(takeAction, t('taken'))
  return (
    <form action={run} className="grid justify-items-end gap-2">
      <input type="hidden" name="collection" value={collection} />
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={`${t('take')}: ${label}`}
      >
        {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
        {pending ? t('taking') : t('take')}
      </Button>
      <ErrorLine state={state} />
    </form>
  )
}

function MemberSelect({
  id,
  name,
  members,
  defaultValue,
  placeholder,
  label,
  invalid,
}: {
  id: string
  name: string
  members: MemberOption[]
  defaultValue?: number | null
  placeholder?: string
  label: string
  invalid?: boolean
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} defaultValue={defaultValue ? String(defaultValue) : undefined}>
        <SelectTrigger id={id} aria-invalid={invalid || undefined}>
          <SelectValue placeholder={placeholder} />
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
  )
}

/**
 * Move a company (and the projects that follow it) or one project to another team member. The
 * note is required: it goes to the history with the change.
 */
export function ReassignForm({
  collection,
  id,
  ownerId,
  members,
  labels,
}: {
  collection: 'companies' | 'projects'
  id: number
  ownerId: number | null
  members: MemberOption[]
  labels: {
    owner: string
    note: string
    noteHint: string
    submit: string
    pending: string
    done: string
    choose: string
  }
}) {
  const uid = useId()
  const { state, pending, onSubmit } = useTeamAction(reassignAction, labels.done)
  const noteError = state.status === 'error' && state.error === 'note'
  return (
    // A new owner (after the refresh) starts a fresh form, with an empty note.
    <form key={ownerId ?? 0} onSubmit={onSubmit} className="grid gap-3">
      <input type="hidden" name="collection" value={collection} />
      <input type="hidden" name="id" value={id} />
      <MemberSelect
        id={`${uid}-owner`}
        name="ownerId"
        label={labels.owner}
        members={members}
        defaultValue={ownerId}
        placeholder={labels.choose}
        invalid={state.status === 'error' && state.error === 'owner'}
      />
      <div className="grid gap-1.5">
        <Label htmlFor={`${uid}-note`}>{labels.note}</Label>
        <Textarea
          id={`${uid}-note`}
          name="note"
          rows={2}
          required
          minLength={3}
          maxLength={REASSIGN_NOTE_MAX}
          aria-invalid={noteError || undefined}
          aria-describedby={`${uid}-hint`}
        />
        <p id={`${uid}-hint`} className="text-[0.82rem] text-muted-foreground">
          {labels.noteHint}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Submit pending={pending} variant="secondary">
          {pending ? labels.pending : labels.submit}
        </Submit>
      </div>
      <ErrorLine state={state} />
    </form>
  )
}

/** Away days and cover for a team member (any member may set them for anyone). */
export function AwayForm({
  members,
  meId,
  today,
}: {
  members: MemberOption[]
  meId: number
  today: string
}) {
  const t = useTranslations('TeamMembers')
  const uid = useId()
  const { state, pending, onSubmit } = useTeamAction(awayAction, t('saved'))
  const invalid = (key: 'dates' | 'cover') => state.status === 'error' && state.error === key
  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <MemberSelect
        id={`${uid}-member`}
        name="memberId"
        label={t('member')}
        members={members}
        defaultValue={meId}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${uid}-from`}>{t('from')}</Label>
          <Input
            id={`${uid}-from`}
            name="from"
            type="date"
            required
            min={today}
            aria-invalid={invalid('dates') || undefined}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${uid}-until`}>{t('until')}</Label>
          <Input
            id={`${uid}-until`}
            name="until"
            type="date"
            required
            min={today}
            aria-invalid={invalid('dates') || undefined}
          />
        </div>
      </div>
      <MemberSelect
        id={`${uid}-cover`}
        name="coverId"
        label={t('cover')}
        members={members}
        placeholder={t('chooseCover')}
        invalid={invalid('cover')}
      />
      <div>
        <Submit pending={pending}>{pending ? t('saving') : t('save')}</Submit>
      </div>
      <ErrorLine state={state} />
    </form>
  )
}

/** Remove a member's away days. */
export function ClearAwayButton({ memberId, label }: { memberId: number; label: string }) {
  const t = useTranslations('TeamMembers')
  const { state, run, pending } = useTeamAction(awayAction, t('cleared'))
  return (
    <form action={run} className="grid justify-items-start gap-2">
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="clear" value="1" />
      <Button
        type="submit"
        size="sm"
        variant="text"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-label={label}
      >
        {t('clear')}
      </Button>
      <ErrorLine state={state} />
    </form>
  )
}
