'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { parsePrice, priceBreakdown, VAT_RATE } from '@/lib/money'
import {
  approveCompanyAction,
  approveProjectAction,
  askCompanyInfoAction,
  askProfileChangesAction,
  markProfileReviewedAction,
  publishProjectAction,
  rejectCompanyAction,
  rejectProjectAction,
  requestProjectChangesAction,
} from '@/lib/team/approvalActions'
import { IDLE, NOTE_MAX, type ReviewError, type ReviewState } from '@/lib/team/approvalFields'
import { cn } from '@/lib/utils'

/*
 * The team's decisions on the approval queue. Each one posts to a Server Action that checks the
 * team member again; the collections' hooks enforce the rules. These only ask, show the checks
 * from the mockup and report. On success: a toast, then the next item in the queue (or the same
 * item, where the next step happens on it, such as publishing an approved project).
 */

type Action = (state: ReviewState, form: FormData) => Promise<ReviewState>

function useDecision(action: Action, done: () => string, goTo: string | null) {
  const router = useRouter()
  const [state, run, pending] = useActionState(action, IDLE)
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (state.status !== 'done' || state.doneAt === seen.current) return
    seen.current = state.doneAt
    toast(done())
    if (goTo) router.replace(goTo, { scroll: false })
    else router.refresh()
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per result
  return { state, run, pending }
}

function ErrorText({ error, id }: { error?: ReviewError; id?: string }) {
  const t = useTranslations('TeamApprovals.errors')
  if (!error) return null
  return (
    <Banner tone="bad" role="alert" id={id}>
      <p>{t(error, { max: NOTE_MAX })}</p>
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

/** The mockup's checks: every box ticked before the main decision opens. Not stored. */
function Checks({ labels, onAll }: { labels: string[]; onAll: (all: boolean) => void }) {
  const t = useTranslations('TeamApprovals')
  const base = useId()
  const [ticked, setTicked] = useState<boolean[]>(() => labels.map(() => false))
  return (
    <fieldset className="grid gap-1">
      <legend className="pb-1 text-[0.88rem] font-semibold">{t('checksTitle')}</legend>
      {labels.map((label, i) => (
        <div key={label} className="flex min-h-11 items-start gap-3 py-1.5">
          <Checkbox
            id={`${base}-${i}`}
            className="mt-0.5"
            checked={ticked[i]}
            onCheckedChange={(value) => {
              const next = ticked.map((v, j) => (j === i ? value === true : v))
              setTicked(next)
              onAll(next.every(Boolean))
            }}
          />
          <Label htmlFor={`${base}-${i}`} className="font-normal">
            {label}
          </Label>
        </div>
      ))}
    </fieldset>
  )
}

/** A note to the company or student, with quick reasons that add their text to it. */
function NoteField({
  id,
  label,
  hint,
  templates,
  invalid,
  errorId,
}: {
  id: string
  label: string
  hint: string
  templates?: { label: string; text: string }[]
  invalid?: boolean
  errorId?: string
}) {
  const [value, setValue] = useState('')
  return (
    <div className="grid gap-2">
      {templates && templates.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {templates.map((tpl) => (
            <button
              key={tpl.label}
              type="button"
              className="min-h-11 rounded-full border-[1.5px] border-line bg-surface px-3.5 text-[0.85rem] font-medium text-foreground hover:bg-surface-2 sm:min-h-9"
              onClick={() => setValue((v) => (v.trim() ? `${v.trim()}\n${tpl.text}` : tpl.text))}
            >
              {tpl.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          id={id}
          name="note"
          rows={3}
          required
          maxLength={NOTE_MAX}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint${invalid && errorId ? ` ${errorId}` : ''}`}
        />
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  )
}

/** A box that opens in place under the buttons (as in the mockup). */
function Box({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="grid gap-3 rounded-item bg-surface-2 p-4">
      {children}
    </div>
  )
}

const noteError = (state: ReviewState) =>
  state.status === 'error' && (state.error === 'note_required' || state.error === 'note_too_long')

/** One "open a box, write a note, send" decision (reject, ask for changes or information). */
function NoteDecision({
  id,
  action,
  open,
  onClose,
  done,
  goTo,
  label,
  hint,
  submit,
  templates,
}: {
  id: number
  action: Action
  open: boolean
  onClose: () => void
  done: string
  goTo: string | null
  label: string
  hint: string
  submit: string
  templates?: { label: string; text: string }[]
}) {
  const t = useTranslations('TeamApprovals')
  const box = useId()
  const { state, run, pending } = useDecision(action, () => done, goTo)
  if (!open) return null
  return (
    <Box id={box}>
      <form action={run} className="grid gap-3" noValidate>
        <input type="hidden" name="id" value={id} />
        <NoteField
          id={`${box}-note`}
          label={label}
          hint={hint}
          templates={templates}
          invalid={noteError(state)}
          errorId={`${box}-error`}
        />
        <ErrorText id={`${box}-error`} error={state.status === 'error' ? state.error : undefined} />
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" size="sm" disabled={pending} aria-busy={pending || undefined}>
            <Pending pending={pending}>{submit}</Pending>
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
        </div>
      </form>
    </Box>
  )
}

/** The buttons that open the boxes. Only one box is open at a time. */
function useBoxes<K extends string>() {
  const [open, setOpen] = useState<K | null>(null)
  const toggle = (key: K) => setOpen((current) => (current === key ? null : key))
  return { open, toggle, close: () => setOpen(null) }
}

// ---------- Companies ----------

export function CompanyActions({
  id,
  name,
  queueHref,
  canAskInfo,
}: {
  id: number
  name: string
  queueHref: string
  /** False while Konnected already waits for the company's answer. */
  canAskInfo: boolean
}) {
  const t = useTranslations('TeamApprovals.company')
  const [checked, setChecked] = useState(false)
  const approve = useDecision(approveCompanyAction, () => t('approvedToast', { name }), queueHref)
  const boxes = useBoxes<'info' | 'reject'>()
  const tpl = (key: 'orgNumber' | 'website' | 'contact') => ({
    label: t(`templates.${key}.label`),
    text: t(`templates.${key}.text`),
  })

  return (
    <div className="grid gap-4">
      <Checks labels={[t('check1'), t('check2'), t('check3')]} onAll={setChecked} />
      <ErrorText error={approve.state.status === 'error' ? approve.state.error : undefined} />
      <div className="flex flex-wrap gap-2.5">
        <form action={approve.run}>
          <input type="hidden" name="id" value={id} />
          <Button
            type="submit"
            disabled={!checked || approve.pending}
            aria-describedby={checked ? undefined : `company-${id}-checkhint`}
            aria-busy={approve.pending || undefined}
          >
            <Pending pending={approve.pending}>{t('approve')}</Pending>
          </Button>
        </form>
        {canAskInfo && (
          <Button
            type="button"
            variant="secondary"
            aria-expanded={boxes.open === 'info'}
            onClick={() => boxes.toggle('info')}
          >
            {t('askInfo')}
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          aria-expanded={boxes.open === 'reject'}
          onClick={() => boxes.toggle('reject')}
        >
          {t('reject')}
        </Button>
      </div>
      {!checked && (
        <p id={`company-${id}-checkhint`} className="text-[0.82rem] text-muted-foreground">
          {t('checkHint')}
        </p>
      )}
      <NoteDecision
        id={id}
        action={askCompanyInfoAction}
        open={boxes.open === 'info'}
        onClose={boxes.close}
        done={t('infoToast', { name })}
        goTo={queueHref}
        label={t('infoLabel')}
        hint={t('infoHint')}
        submit={t('infoSubmit')}
        templates={[tpl('orgNumber'), tpl('website'), tpl('contact')]}
      />
      <NoteDecision
        id={id}
        action={rejectCompanyAction}
        open={boxes.open === 'reject'}
        onClose={boxes.close}
        done={t('rejectedToast', { name })}
        goTo={queueHref}
        label={t('rejectLabel')}
        hint={t('rejectHint')}
        submit={t('rejectSubmit')}
      />
    </div>
  )
}

// ---------- Projects ----------

export function ProjectActions({
  id,
  title,
  companyChoice,
  companyApproved,
  itemHref,
  queueHref,
}: {
  id: number
  title: string
  /** What the company chose; Konnected decides. */
  companyChoice: 'paid' | 'unpaid' | null
  /** Approving waits until Konnected has approved the company (the page says why). */
  companyApproved: boolean
  /** This project in the queue: after approval it waits here to be published. */
  itemHref: string
  queueHref: string
}) {
  const t = useTranslations('TeamApprovals.project')
  const format = useFormatter()
  const base = useId()
  const [checked, setChecked] = useState(false)
  const [pay, setPay] = useState<'paid' | 'unpaid'>(companyChoice ?? 'paid')
  const [price, setPrice] = useState('')
  const approve = useDecision(approveProjectAction, () => t('approvedToast', { title }), itemHref)
  const boxes = useBoxes<'changes' | 'reject'>()
  const parsed = parsePrice(price)
  const money = (value: number) =>
    format.number(value, {
      style: 'currency',
      currency: 'NOK',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  const priceError =
    approve.state.status === 'error' &&
    (approve.state.error === 'price_required' || approve.state.error === 'price_invalid')
  const tpl = (key: 'deliverable' | 'workload' | 'language' | 'job' | 'paid') => ({
    label: t(`templates.${key}.label`),
    text: t(`templates.${key}.text`),
  })

  const formId = `${base}-approve`
  return (
    <div className="grid gap-4">
      <form id={formId} action={approve.run} className="grid gap-4" noValidate>
        <input type="hidden" name="id" value={id} />
        <Checks labels={[t('check1'), t('check2'), t('check3'), t('check4')]} onAll={setChecked} />

        <fieldset className="grid gap-2" aria-describedby={`${base}-payhint`}>
          <legend className="pb-1 text-[0.88rem] font-semibold">{t('payTitle')}</legend>
          <div className="flex flex-wrap gap-2">
            {(['paid', 'unpaid'] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-line bg-surface px-4 font-medium has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary sm:min-h-9',
                  pay === value && 'border-transparent bg-tint text-tint-foreground',
                )}
              >
                <input
                  type="radio"
                  name="pay"
                  value={value}
                  checked={pay === value}
                  onChange={() => setPay(value)}
                  className="size-4 accent-[var(--primary)]"
                />
                {t(`pay.${value}`)}
              </label>
            ))}
          </div>
          <p id={`${base}-payhint`} className="text-[0.82rem] text-muted-foreground">
            {companyChoice ? t('payHint', { choice: t(`pay.${companyChoice}`) }) : t('payHintNone')}
          </p>
        </fieldset>

        {pay === 'paid' && (
          <div className="grid gap-1.5">
            <Label htmlFor={`${base}-price`}>{t('priceLabel')}</Label>
            <Input
              id={`${base}-price`}
              name="price"
              inputMode="numeric"
              autoComplete="off"
              className="max-w-[16rem]"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-invalid={priceError || undefined}
              aria-describedby={`${base}-price-hint ${base}-price-sum`}
            />
            <p id={`${base}-price-hint`} className="text-[0.82rem] text-muted-foreground">
              {t('priceHint')}
            </p>
            <dl
              id={`${base}-price-sum`}
              aria-live="polite"
              className="grid w-fit grid-cols-[max-content_max-content] gap-x-6 gap-y-1 rounded-item bg-surface-2 px-4 py-3 text-[0.9rem]"
            >
              <dt className="text-muted-foreground">{t('priceExVat')}</dt>
              <dd className="text-right tabular-nums">{parsed ? money(parsed) : '–'}</dd>
              <dt className="text-muted-foreground">{t('vat', { rate: VAT_RATE * 100 })}</dt>
              <dd className="text-right tabular-nums">
                {parsed ? money(priceBreakdown(parsed).vat) : '–'}
              </dd>
              <dt className="font-semibold">{t('total')}</dt>
              <dd className="text-right font-semibold tabular-nums">
                {parsed ? money(priceBreakdown(parsed).total) : '–'}
              </dd>
            </dl>
          </div>
        )}
        {pay === 'unpaid' && (
          <Banner>
            <p className="text-[0.88rem]">{t('unpaidNote')}</p>
          </Banner>
        )}
        <ErrorText error={approve.state.status === 'error' ? approve.state.error : undefined} />
      </form>

      <div className="flex flex-wrap gap-2.5">
        <Button
          type="submit"
          form={formId}
          disabled={!companyApproved || !checked || approve.pending}
          aria-describedby={checked ? undefined : `${base}-checkhint`}
          aria-busy={approve.pending || undefined}
        >
          <Pending pending={approve.pending}>{t('approve')}</Pending>
        </Button>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={boxes.open === 'changes'}
          onClick={() => boxes.toggle('changes')}
        >
          {t('changes')}
        </Button>
        <Button
          type="button"
          variant="text"
          aria-expanded={boxes.open === 'reject'}
          onClick={() => boxes.toggle('reject')}
        >
          {t('reject')}
        </Button>
      </div>
      {!checked && (
        <p id={`${base}-checkhint`} className="text-[0.82rem] text-muted-foreground">
          {t('checkHint')}
        </p>
      )}
      <NoteDecision
        id={id}
        action={requestProjectChangesAction}
        open={boxes.open === 'changes'}
        onClose={boxes.close}
        done={t('changesToast', { title })}
        goTo={queueHref}
        label={t('changesLabel')}
        hint={t('changesHint')}
        submit={t('changesSubmit')}
        templates={[tpl('deliverable'), tpl('workload'), tpl('language'), tpl('job'), tpl('paid')]}
      />
      <NoteDecision
        id={id}
        action={rejectProjectAction}
        open={boxes.open === 'reject'}
        onClose={boxes.close}
        done={t('rejectedToast', { title })}
        goTo={queueHref}
        label={t('rejectLabel')}
        hint={t('rejectHint')}
        submit={t('rejectSubmit')}
      />
    </div>
  )
}

// ---------- Publishing ----------

export function PublishAction({
  id,
  title,
  companyApproved,
  queueHref,
}: {
  id: number
  title: string
  /** Publishing waits until Konnected has approved the company (the page says why). */
  companyApproved: boolean
  queueHref: string
}) {
  const t = useTranslations('TeamApprovals.publish')
  const box = useId()
  const [open, setOpen] = useState(false)
  const publish = useDecision(publishProjectAction, () => t('toast', { title }), queueHref)
  return (
    <div className="grid gap-3">
      <div>
        <Button
          type="button"
          aria-expanded={open}
          aria-controls={box}
          disabled={!companyApproved}
          onClick={() => setOpen((v) => !v)}
        >
          {t('button')}
        </Button>
      </div>
      {open && companyApproved && (
        <Box id={box}>
          <p className="font-semibold">{t('confirmTitle', { title })}</p>
          <p className="text-[0.88rem] text-muted-foreground">{t('confirmBody')}</p>
          <ErrorText error={publish.state.status === 'error' ? publish.state.error : undefined} />
          <form action={publish.run} className="flex flex-wrap gap-2.5">
            <input type="hidden" name="id" value={id} />
            <Button
              type="submit"
              size="sm"
              disabled={publish.pending}
              aria-busy={publish.pending || undefined}
            >
              <Pending pending={publish.pending}>{t('confirm')}</Pending>
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </form>
        </Box>
      )}
    </div>
  )
}

// ---------- Student profiles ----------

export function ProfileActions({
  id,
  name,
  queueHref,
  again,
  canAsk,
}: {
  id: number
  name: string
  queueHref: string
  /** A reviewed profile the student changed: "Mark as reviewed again". */
  again: boolean
  /** False while Konnected already waits for the student's changes. */
  canAsk: boolean
}) {
  const t = useTranslations('TeamApprovals.profile')
  const [checked, setChecked] = useState(false)
  const review = useDecision(
    markProfileReviewedAction,
    () => t('reviewedToast', { name }),
    queueHref,
  )
  const boxes = useBoxes<'ask'>()
  const tpl = (key: 'cv' | 'year' | 'interests' | 'pitch') => ({
    label: t(`templates.${key}.label`),
    text: t(`templates.${key}.text`),
  })
  return (
    <div className="grid gap-4">
      {!again && <Checks labels={[t('check1'), t('check2'), t('check3')]} onAll={setChecked} />}
      <ErrorText error={review.state.status === 'error' ? review.state.error : undefined} />
      <div className="flex flex-wrap gap-2.5">
        <form action={review.run}>
          <input type="hidden" name="id" value={id} />
          <Button
            type="submit"
            disabled={(!again && !checked) || review.pending}
            aria-describedby={again || checked ? undefined : `profile-${id}-checkhint`}
            aria-busy={review.pending || undefined}
          >
            <Pending pending={review.pending}>{again ? t('reviewAgain') : t('review')}</Pending>
          </Button>
        </form>
        {canAsk && (
          <Button
            type="button"
            variant="secondary"
            aria-expanded={boxes.open === 'ask'}
            onClick={() => boxes.toggle('ask')}
          >
            {t('ask')}
          </Button>
        )}
      </div>
      {!again && !checked && (
        <p id={`profile-${id}-checkhint`} className="text-[0.82rem] text-muted-foreground">
          {t('checkHint')}
        </p>
      )}
      <NoteDecision
        id={id}
        action={askProfileChangesAction}
        open={boxes.open === 'ask'}
        onClose={boxes.close}
        done={t('askToast', { name })}
        goTo={queueHref}
        label={t('askLabel')}
        hint={t('askHint')}
        submit={t('askSubmit')}
        templates={[tpl('cv'), tpl('year'), tpl('interests'), tpl('pitch')]}
      />
    </div>
  )
}
