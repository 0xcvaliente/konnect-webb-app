'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { useRouter } from '@/i18n/navigation'
import { MATCH_IDLE, type MatchState } from '@/lib/matching/fields'
import { selectAction, shortlistAction } from '@/lib/team/matchingActions'

/*
 * The team's decisions on the Matching screen. Each posts to a Server Action that checks the team
 * member again; the Applications hook holds the rules (a published project without a match, a
 * reviewed profile, at most 2 running projects) and makes the match. These only ask and report.
 */

function useDecision(
  action: (state: MatchState, form: FormData) => Promise<MatchState>,
  done: () => string,
  goTo?: string,
) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, MATCH_IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status === 'idle' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    if (state.status === 'done') {
      toast(done())
      if (goTo) router.replace(goTo, { scroll: false })
      else router.refresh()
    } else {
      // The list may be out of date (someone else decided): show what is true now.
      router.refresh()
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

function ErrorText({ state, id }: { state: MatchState; id: string }) {
  const t = useTranslations('TeamMatching.errors')
  if (state.status !== 'error') return null
  return (
    <Banner tone="bad" role="alert" id={id}>
      <p className="text-[0.88rem]">{t(state.error)}</p>
    </Banner>
  )
}

export function ShortlistButton({ applicationId, name }: { applicationId: number; name: string }) {
  const t = useTranslations('TeamMatching')
  const errorId = useId()
  const { state, run, pending } = useDecision(shortlistAction, () =>
    t('shortlistedToast', { name }),
  )
  return (
    <form action={run} className="contents">
      <input type="hidden" name="id" value={applicationId} />
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={pending}
        aria-label={t('shortlistName', { name })}
        aria-describedby={state.status === 'error' ? errorId : undefined}
      >
        {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
        {t('shortlist')}
      </Button>
      {state.status === 'error' && (
        <div className="basis-full">
          <ErrorText state={state} id={errorId} />
        </div>
      )}
    </form>
  )
}

/**
 * "Select" opens a box in place that says what happens (mockup: the student is selected and
 * emailed, the others become not selected and get a kind email, the project becomes matched, the
 * company sees only what the student agreed to share), then confirms.
 */
export function SelectBox({
  applicationId,
  name,
  first,
  others,
  company,
  projectTitle,
  shares,
  queueHref,
}: {
  applicationId: number
  name: string
  first: string
  others: number
  company: string
  projectTitle: string
  /** What the student ticked to share, as words. */
  shares: string[]
  queueHref: string
}) {
  const t = useTranslations('TeamMatching')
  const [open, setOpen] = useState(false)
  const box = useId()
  const errorId = useId()
  const { state, run, pending } = useDecision(
    selectAction,
    () => t('selectedToast', { name, title: projectTitle }),
    queueHref,
  )
  const format = useFormatter()
  const list = (items: string[]) => format.list(items, { type: 'conjunction' })

  return (
    <>
      <Button
        type="button"
        size="sm"
        aria-label={t('selectName', { name })}
        aria-expanded={open}
        aria-controls={box}
        onClick={() => setOpen((v) => !v)}
      >
        {t('select')}
      </Button>
      {open && (
        <div id={box} className="grid basis-full gap-3 rounded-item bg-surface-2 p-4">
          <p className="font-semibold">{t('confirmTitle', { name })}</p>
          <ul className="grid list-disc gap-1 pl-5 text-[0.88rem]">
            <li>{t('confirmSelected', { first })}</li>
            {others > 0 && <li>{t('confirmOthers', { count: others })}</li>}
            <li>{t('confirmMatched')}</li>
            <li>
              {shares.length
                ? t('confirmShares', { company, first, items: list(shares) })
                : t('confirmSharesNothing', { company, first })}
            </li>
          </ul>
          <ErrorText state={state} id={errorId} />
          <form action={run} className="flex flex-wrap gap-2">
            <input type="hidden" name="id" value={applicationId} />
            <Button
              type="submit"
              size="sm"
              disabled={pending}
              aria-describedby={state.status === 'error' ? errorId : undefined}
            >
              {pending && (
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
              )}
              {t('confirm')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </form>
        </div>
      )}
    </>
  )
}
