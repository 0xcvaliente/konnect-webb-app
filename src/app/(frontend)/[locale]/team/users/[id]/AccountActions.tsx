'use client'

import { LoaderCircleIcon, LogOutIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import {
  fixRoleAction,
  pauseAccountAction,
  reactivateAccountAction,
  signOutEverywhereAction,
} from '@/lib/team/actions'
import { type AccountActionState, type AccountError, IDLE, REASON_MAX } from '@/lib/team/fields'

/*
 * The three team actions on the "User account" screen. Each opens a short confirmation in place
 * (as in the mockup), posts to a Server Action that checks the team member again, then shows a
 * toast and reloads the page data. The server decides; these only ask and report.
 */

type Action = (state: AccountActionState, form: FormData) => Promise<AccountActionState>

/** Run an action; on success show `done` as a toast and reload the server data. */
function useAccountAction(action: Action, done: () => string, onDone?: () => void) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status !== 'done' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    toast(done())
    onDone?.()
    router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

function ErrorText({ error, id }: { error?: AccountError; id?: string }) {
  const t = useTranslations('TeamAccount.errors')
  if (!error) return null
  const key = {
    forbidden: 'forbidden',
    not_found: 'notFound',
    has_work: 'hasWork',
    not_allowed: 'notAllowed',
    reason_required: 'reasonRequired',
    reason_too_long: 'reasonTooLong',
    generic: 'generic',
  } as const
  return (
    <Banner tone="bad" role="alert" id={id}>
      <p>{t(key[error], { max: REASON_MAX })}</p>
    </Banner>
  )
}

function Pending({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <>
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </>
  )
}

/** The confirmation box that opens in place under a button. */
function Confirm({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="grid gap-3 rounded-item bg-surface-2 p-4">
      {children}
    </div>
  )
}

export function RoleCard({
  userId,
  name,
  state: roleState,
  to,
}: {
  userId: number
  name: string
  /** open: can change; locked: has work; pending: no role yet; team: a team account. */
  state: 'open' | 'locked' | 'pending' | 'team'
  to: 'student' | 'company' | null
}) {
  const t = useTranslations('TeamAccount')
  const box = useId()
  const [open, setOpen] = useState(false)
  const { state, run, pending } = useAccountAction(
    fixRoleAction,
    () => t(`roleChanged.${to ?? 'student'}`, { name }),
    () => setOpen(false),
  )

  return (
    <Card className="gap-4">
      <CardTitle>{t('roleTitle')}</CardTitle>
      <p className="text-[0.88rem] text-muted-foreground">{t('roleBody')}</p>
      {roleState === 'open' && to && (
        <>
          <div>
            <Button
              type="button"
              aria-expanded={open}
              aria-controls={box}
              onClick={() => setOpen((v) => !v)}
            >
              {t(`changeTo.${to}`)}
            </Button>
          </div>
          {open && (
            <Confirm id={box}>
              <p className="font-semibold">{t(`confirmTitle.${to}`, { name })}</p>
              <ul className="grid list-disc gap-1 pl-5 text-[0.88rem] text-muted-foreground">
                <li>{t(`confirmRemoved.${to}`, { name })}</li>
                <li>{t(`confirmNext.${to}`, { name })}</li>
                <li>{t(`confirmReview.${to}`)}</li>
                <li>{t('confirmLog', { name })}</li>
              </ul>
              <ErrorText error={state.status === 'error' ? state.error : undefined} />
              <form action={run} className="flex flex-wrap gap-2.5">
                <input type="hidden" name="userId" value={userId} />
                <input type="hidden" name="role" value={to} />
                <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
                  <Pending pending={pending}>{t('confirmChange')}</Pending>
                </Button>
                <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
                  {t('cancel')}
                </Button>
              </form>
            </Confirm>
          )}
        </>
      )}
      {roleState === 'locked' && (
        <div className="grid gap-1.5">
          <div>
            <Button type="button" variant="secondary" disabled aria-describedby={`${box}-why`}>
              {t('changeTo.' + (to ?? 'student'))}
            </Button>
          </div>
          <p id={`${box}-why`} className="text-[0.85rem] text-muted-foreground">
            {t('roleLocked')}
          </p>
        </div>
      )}
      {roleState === 'pending' && <p className="text-[0.88rem]">{t('rolePending')}</p>}
      {roleState === 'team' && <p className="text-[0.88rem]">{t('roleTeam')}</p>}
      <p className="text-[0.85rem] text-muted-foreground">{t('adminNote')}</p>
    </Card>
  )
}

export function PauseCard({
  userId,
  name,
  paused,
  isTeam,
  reason,
}: {
  userId: number
  name: string
  paused: boolean
  isTeam: boolean
  reason: string | null
}) {
  const t = useTranslations('TeamAccount')
  const box = useId()
  const [open, setOpen] = useState(false)
  const pause = useAccountAction(
    pauseAccountAction,
    () => t('pausedToast', { name }),
    () => setOpen(false),
  )
  const reactivate = useAccountAction(reactivateAccountAction, () =>
    t('reactivatedToast', { name }),
  )
  const reasonError =
    pause.state.status === 'error' &&
    (pause.state.error === 'reason_required' || pause.state.error === 'reason_too_long')

  if (paused) {
    return (
      <Card className="gap-4">
        <CardTitle>{t('pausedTitle')}</CardTitle>
        <p className="text-[0.88rem] text-muted-foreground">{t('pausedBody', { name })}</p>
        {reason && (
          <p className="text-[0.88rem] [overflow-wrap:anywhere]">{t('pausedReason', { reason })}</p>
        )}
        <ErrorText
          error={reactivate.state.status === 'error' ? reactivate.state.error : undefined}
        />
        <form action={reactivate.run}>
          <input type="hidden" name="userId" value={userId} />
          <Button
            type="submit"
            variant="normal"
            disabled={reactivate.pending}
            aria-busy={reactivate.pending || undefined}
          >
            <Pending pending={reactivate.pending}>{t('reactivate')}</Pending>
          </Button>
        </form>
      </Card>
    )
  }

  return (
    <Card className="gap-4">
      <CardTitle>{t('pauseTitle')}</CardTitle>
      <p className="text-[0.88rem] text-muted-foreground">{t('pauseBody', { name })}</p>
      {isTeam ? (
        <p className="text-[0.88rem]">{t('pauseTeam')}</p>
      ) : (
        <>
          <div>
            <Button
              type="button"
              variant="secondary"
              aria-expanded={open}
              aria-controls={box}
              onClick={() => setOpen((v) => !v)}
            >
              {t('pause')}
            </Button>
          </div>
          {open && (
            <Confirm id={box}>
              <form action={pause.run} className="grid gap-3" noValidate>
                <input type="hidden" name="userId" value={userId} />
                <div className="grid gap-1.5">
                  <Label htmlFor={`${box}-reason`}>{t('reason')}</Label>
                  <Textarea
                    id={`${box}-reason`}
                    name="reason"
                    rows={2}
                    required
                    maxLength={REASON_MAX}
                    aria-invalid={reasonError || undefined}
                    aria-describedby={`${box}-hint${reasonError ? ` ${box}-error` : ''}`}
                  />
                  <p id={`${box}-hint`} className="text-[0.82rem] text-muted-foreground">
                    {t('reasonHint', { name })}
                  </p>
                </div>
                <ErrorText
                  id={`${box}-error`}
                  error={pause.state.status === 'error' ? pause.state.error : undefined}
                />
                <div className="flex flex-wrap gap-2.5">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={pause.pending}
                    aria-busy={pause.pending || undefined}
                  >
                    <Pending pending={pause.pending}>{t('pauseConfirm')}</Pending>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setOpen(false)}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </form>
            </Confirm>
          )}
        </>
      )}
    </Card>
  )
}

export function SignOutEverywhere({
  userId,
  name,
  self,
}: {
  userId: number
  name: string
  /** The team member's own account: they are signed out too. */
  self: boolean
}) {
  const t = useTranslations('TeamAccount')
  const box = useId()
  const [open, setOpen] = useState(false)
  const { state, run, pending } = useAccountAction(
    signOutEverywhereAction,
    () => t('signedOutToast', { name }),
    () => setOpen(false),
  )

  return (
    <div className="grid gap-3">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        aria-expanded={open}
        aria-controls={box}
        onClick={() => setOpen((v) => !v)}
      >
        <LogOutIcon aria-hidden="true" />
        {t('signOutEverywhere')}
      </Button>
      {open && (
        <Confirm id={box}>
          <p className="font-semibold">{t('signOutTitle', { name })}</p>
          <p className="text-[0.88rem] text-muted-foreground">{t('signOutBody', { name })}</p>
          {self && <p className="text-[0.88rem]">{t('signOutSelf')}</p>}
          <ErrorText error={state.status === 'error' ? state.error : undefined} />
          <form action={run} className="flex flex-wrap gap-2.5">
            <input type="hidden" name="userId" value={userId} />
            <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
              <Pending pending={pending}>{t('signOutEverywhere')}</Pending>
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </form>
        </Confirm>
      )}
    </div>
  )
}
