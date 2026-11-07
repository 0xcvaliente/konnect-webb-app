'use client'

import { FilePlus2Icon, LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { useRouter } from '@/i18n/navigation'
import { requestAgreementAction, voidAgreementAction } from '@/lib/agreements/actions'
import { type AgreementActionState, IDLE } from '@/lib/agreements/state'

/*
 * The team's buttons on the agreement screens: make an agreement, withdraw one. Each posts to a
 * Server Action that checks the team member again, then shows a toast and reloads the data.
 */

type Action = (state: AgreementActionState, form: FormData) => Promise<AgreementActionState>

function useAgreementAction(action: Action, done: (state: AgreementActionState) => string) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(done(state))
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

function ErrorBanner({ state }: { state: AgreementActionState }) {
  const t = useTranslations('TeamAgreements.errors')
  const f = useTranslations('AgreementFields')
  if (state.status !== 'error') return null
  const known = [
    'forbidden',
    'not_found',
    'wrong_status',
    'no_template',
    'missing_values',
    'already_exists',
  ] as const
  const key = (known as readonly string[]).includes(state.error)
    ? (state.error as (typeof known)[number])
    : 'generic'
  const fields = (state.fields ?? []).map((field) => f(field.replace(/\./g, '_'))).join(', ')
  return (
    <Banner tone="bad" role="alert">
      <p>{t(key, { fields })}</p>
    </Banner>
  )
}

function Busy({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <>
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </>
  )
}

/** "Make the agreement" for a project (company) or a match (student). */
export function MakeAgreementButton({
  kind,
  projectId,
  matchId,
}: {
  kind: 'company' | 'student'
  projectId?: number
  matchId?: number
}) {
  const t = useTranslations('TeamAgreements')
  const { state, run, pending } = useAgreementAction(requestAgreementAction, () => t('madeToast'))
  return (
    <form action={run} className="grid gap-2">
      <input type="hidden" name="kind" value={kind} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}
      {matchId && <input type="hidden" name="matchId" value={matchId} />}
      <div>
        <Button
          type="submit"
          size="sm"
          variant="normal"
          disabled={pending}
          aria-busy={pending || undefined}
        >
          <Busy pending={pending}>
            {!pending && <FilePlus2Icon aria-hidden="true" />}
            {pending ? t('making') : t('make')}
          </Busy>
        </Button>
      </div>
      <ErrorBanner state={state} />
    </form>
  )
}

/** Withdraw an unfinished agreement, with a short confirmation in place. */
export function WithdrawAgreement({ agreementId }: { agreementId: number }) {
  const t = useTranslations('TeamAgreements')
  const box = useId()
  const [open, setOpen] = useState(false)
  const { state, run, pending } = useAgreementAction(voidAgreementAction, (s) =>
    s.status === 'done' && s.id !== agreementId ? t('remadeToast') : t('withdrawnToast'),
  )
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2.5">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={box}
          onClick={() => setOpen((v) => !v)}
        >
          {t('withdrawAndRemake')}
        </Button>
      </div>
      {open && (
        <div id={box} className="grid gap-3 rounded-item bg-surface-2 p-4">
          <p className="text-[0.88rem] text-muted-foreground">{t('withdrawBody')}</p>
          <ErrorBanner state={state} />
          <form action={run} className="flex flex-wrap gap-2.5">
            <input type="hidden" name="agreementId" value={agreementId} />
            <Button
              type="submit"
              name="remake"
              value="yes"
              size="sm"
              disabled={pending}
              aria-busy={pending || undefined}
            >
              <Busy pending={pending}>{t('withdrawAndRemake')}</Busy>
            </Button>
            <Button
              type="submit"
              name="remake"
              value="no"
              size="sm"
              variant="secondary"
              disabled={pending}
            >
              {t('withdraw')}
            </Button>
            <Button type="button" size="sm" variant="text" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </form>
        </div>
      )}
    </div>
  )
}
