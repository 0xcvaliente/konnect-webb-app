'use client'

import {
  CircleCheckIcon,
  ClockIcon,
  CoinsIcon,
  EyeIcon,
  HeartHandshakeIcon,
  LoaderCircleIcon,
  SendIcon,
} from 'lucide-react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { TextField } from '@/components/app/AuthForm'
import { Banner } from '@/components/app/Banner'
import { type BriefFileInfo, BriefFilesField, deleteBrief } from '@/components/app/BriefFilesField'
import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { ProjectDetails } from '@/components/app/ProjectDetails'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useRouter } from '@/i18n/navigation'
import { saveProjectDraftAction, sendProjectForReviewAction } from '@/lib/projects/actions'
import {
  DURATION_WEEKS,
  LIMITS,
  type PayChoice,
  PAY_CHOICES,
  parseSkills,
  problemsForReview,
  type ProjectField,
  type ProjectFieldErrors,
  type ProjectFieldProblem,
  type ProjectInput,
  todayInOslo,
  WORK_MODES,
  type WorkMode,
} from '@/lib/projects/fields'
import { createSaveQueue } from '@/lib/projects/saveQueue'
import { cn } from '@/lib/utils'

/** How long the form waits after the last change before it saves the draft. */
const AUTOSAVE_MS = 1200

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'needsTitle' }
  | { kind: 'error' }

type FormError = 'fix' | 'forbidden' | 'not_editable' | 'not_approved' | 'not_found' | 'generic'

/** The message for a field problem the server or the form found. */
function useProblemText() {
  const f = useTranslations('ProjectFields')
  return (field: ProjectField, problem: ProjectFieldProblem | undefined): string | undefined => {
    if (!problem) return undefined
    if (problem === 'required')
      return ['workMode', 'durationWeeks', 'paidOrUnpaid'].includes(field)
        ? f('errors.requiredOne')
        : f('errors.required')
    if (problem === 'too_long') {
      const max =
        field === 'desiredSkills'
          ? LIMITS.skill
          : (LIMITS[field as keyof typeof LIMITS] as number | undefined)
      return f('errors.tooLong', { max: max ?? 0 })
    }
    if (problem === 'too_many')
      return field === 'desiredSkills'
        ? f('errors.tooManySkills', { max: LIMITS.skills })
        : f('errors.tooManyFiles')
    if (problem === 'past') return f('errors.past')
    if (problem === 'before_deadline') return f('errors.beforeDeadline')
    if (field === 'workloadHours')
      return f('errors.hoursInvalid', { min: LIMITS.hoursMin, max: LIMITS.hoursMax })
    if (field === 'startDate' || field === 'deadline') return f('errors.dateInvalid')
    return f('errors.invalid')
  }
}

/** The form's values as the review check reads them. */
function forReview(values: ProjectInput) {
  const n = (v: string) => (v.trim() && Number.isInteger(Number(v)) ? Number(v) : null)
  return {
    ...values,
    desiredSkills: parseSkills(values.desiredSkills),
    workloadHours: n(values.workloadHours),
    durationWeeks: n(values.durationWeeks),
  }
}

/**
 * The company's project form ("Final pass" mockup, Submit a project). The draft saves itself a
 * moment after each change (the first save creates it); "Preview" shows the project the way
 * students will see it once Konnected publishes it; "Send for review" saves and sends it in one
 * step. A pending company can write drafts but sends only after approval. The server checks every
 * rule again; the checks here only answer faster. There is no price input: Konnected sets the
 * price at review.
 */
export function ProjectForm({
  id: initialId,
  initial,
  files: initialFiles,
  canSend,
  companyName,
  companyLogoUrl,
  changesNote,
}: {
  id?: number
  initial: ProjectInput
  files: BriefFileInfo[]
  /** False while Konnected has not approved the company yet. */
  canSend: boolean
  companyName: string
  companyLogoUrl?: string | null
  /** Set when Konnected asked for changes: its note, or '' when it wrote none. */
  changesNote?: string | null
}) {
  const t = useTranslations('ProjectForm')
  const f = useTranslations('ProjectFields')
  const locale = useLocale()
  const format = useFormatter()
  const router = useRouter()
  const problemText = useProblemText()

  const [values, setValues] = useState<ProjectInput>(initial)
  const [files, setFiles] = useState<BriefFileInfo[]>(initialFiles)
  const [errors, setErrors] = useState<ProjectFieldErrors>({})
  const [formError, setFormError] = useState<FormError | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [sending, setSending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  const formRef = useRef<HTMLFormElement>(null)
  const idRef = useRef<number | undefined>(initialId)
  const valuesRef = useRef(values)
  const dirty = useRef(false)
  /** Files on the project as last saved. Others that are removed were never saved. */
  const savedFiles = useRef(new Set(initialFiles.map((file) => file.id)))
  const today = todayInOslo()

  useEffect(() => {
    valuesRef.current = values
  }, [values])

  const focusFirstInvalid = () =>
    requestAnimationFrame(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    )

  /** Use a project id the server gave: later visits and reloads open that draft again. */
  const adoptId = useCallback(
    (id: number | undefined) => {
      if (!id || id === idRef.current) return
      idRef.current = id
      window.history.replaceState(null, '', `/${locale}/company/projects/${id}/edit`)
    },
    [locale],
  )

  /** One draft save. The queue below runs it, one at a time and never during or after a send. */
  const saveDraftOnce = useCallback(async (): Promise<void> => {
    if (!dirty.current) return
    const current = valuesRef.current
    if (!current.title.trim()) {
      setSave({ kind: 'needsTitle' })
      return
    }
    dirty.current = false
    setSave({ kind: 'saving' })
    const result = await saveProjectDraftAction(idRef.current, current).catch(() => null)
    if (!result) {
      dirty.current = true
      setSave({ kind: 'error' })
      return
    }
    adoptId(result.id)
    if (result.status === 'saved') {
      savedFiles.current = new Set(current.attachments)
      setSave({ kind: 'saved', at: Date.now() })
      setErrors((old) => {
        // Problems the last save no longer has are gone; keep "required" marks from a send.
        const next: ProjectFieldErrors = {}
        for (const [key, value] of Object.entries(old))
          if (value === 'required' || value === 'past' || value === 'before_deadline')
            next[key as ProjectField] = value
        return next
      })
      return
    }
    dirty.current = true
    setSave({ kind: 'error' })
    if (result.fields) setErrors(result.fields)
    else setFormError(result.error ?? 'generic')
  }, [adoptId])

  const [queue] = useState(() => createSaveQueue(AUTOSAVE_MS))
  useEffect(() => () => queue.cancel(), [queue])

  // Auto-save a moment after the last change.
  useEffect(() => {
    if (dirty.current) queue.schedule(saveDraftOnce)
  }, [values, queue, saveDraftOnce])

  // Ask before leaving with changes that are not saved yet.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const set = <K extends keyof ProjectInput>(key: K, value: ProjectInput[K]) => {
    dirty.current = true
    setFormError(null)
    setValues((old) => ({ ...old, [key]: value }))
    if (errors[key as ProjectField]) {
      setErrors((old) => {
        const next = { ...old }
        delete next[key as ProjectField]
        return next
      })
    }
  }

  const changeFiles = (next: BriefFileInfo[], removed?: BriefFileInfo) => {
    setFiles(next)
    set(
      'attachments',
      next.map((file) => file.id),
    )
    // A file that was never saved on the project is removed at once; the server removes saved
    // ones when the draft is saved without them.
    if (removed && !savedFiles.current.has(removed.id)) void deleteBrief(removed.id)
  }

  const error = (field: ProjectField) => problemText(field, errors[field])

  /** Mark what is missing before a send, without asking the server. */
  const checkReady = (): boolean => {
    const problems = problemsForReview(forReview(values), today)
    if (Object.keys(problems).length) {
      setErrors(problems)
      setFormError('fix')
      focusFirstInvalid()
      return false
    }
    return true
  }

  const send = async () => {
    setSending(true)
    setFormError(null)
    // The queue cancels the pending autosave and runs no save during the send or after it went
    // through, so a late autosave cannot create a second project or fail on the sent one.
    const result = await queue.send(
      () => sendProjectForReviewAction(idRef.current, valuesRef.current).catch(() => null),
      (answer) => answer?.status === 'sent' && Boolean(answer.id),
    )
    setSending(false)
    setConfirmOpen(false)
    if (result?.status === 'sent' && result.id) {
      idRef.current = result.id
      dirty.current = false
      router.push(`/company/projects/${result.id}?sent=1`)
      return
    }
    // Not sent: the draft may exist now, and saving works again.
    adoptId(result?.id)
    if (dirty.current) queue.schedule(saveDraftOnce)
    if (result?.fields) {
      setErrors(result.fields)
      setFormError('fix')
      focusFirstInvalid()
      return
    }
    setFormError(result?.error ?? 'generic')
  }

  const saveDraft = async () => {
    dirty.current = true
    await queue.saveNow(saveDraftOnce)
    if (valuesRef.current.title.trim()) toast(t('draftSaved'))
    else {
      setErrors((old) => ({ ...old, title: 'required' }))
      focusFirstInvalid()
    }
  }

  const saveText =
    save.kind === 'saving'
      ? t('autosave.saving')
      : save.kind === 'saved'
        ? t('autosave.saved', {
            time: format.dateTime(new Date(save.at), { timeStyle: 'short' }),
          })
        : save.kind === 'needsTitle'
          ? t('autosave.needsTitle')
          : save.kind === 'error'
            ? t('autosave.error')
            : initialId
              ? t('autosave.idle')
              : t('autosave.new')

  const formErrorText = formError
    ? formError === 'fix'
      ? t('errors.fix')
      : t(`errors.${formError}`)
    : null

  const preview = forReview(values)
  const workMode = values.workMode as WorkMode | ''
  const paid = values.paidOrUnpaid as PayChoice | ''

  return (
    <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <Card>
        <form
          ref={formRef}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (canSend && checkReady()) setConfirmOpen(true)
          }}
          className="grid gap-5"
        >
          {typeof changesNote === 'string' && (
            <Banner tone="warn">
              <p className="font-semibold">{t('changesTitle')}</p>
              <p className="whitespace-pre-line [overflow-wrap:anywhere]">
                {changesNote.trim() || t('changesBody')}
              </p>
            </Banner>
          )}
          {!canSend && (
            <Banner tone="warn" icon={ClockIcon}>
              <p className="font-semibold">{t('pendingTitle')}</p>
              <p className="text-[0.88rem] text-muted-foreground">{t('pendingBody')}</p>
            </Banner>
          )}
          {formErrorText && (
            <Banner tone="bad" role="alert">
              <p>{formErrorText}</p>
            </Banner>
          )}

          <TextField
            id="p-title"
            name="title"
            label={f('title')}
            hint={f('titleHint')}
            value={values.title}
            onChange={(e) => set('title', e.target.value)}
            maxLength={LIMITS.title}
            autoComplete="off"
            error={error('title')}
          />
          <AreaField
            id="p-description"
            label={f('description')}
            hint={f('descriptionHint')}
            value={values.description}
            onChange={(v) => set('description', v)}
            rows={5}
            maxLength={LIMITS.description}
            error={error('description')}
          />
          <AreaField
            id="p-tasks"
            label={f('tasksOptional')}
            hint={f('tasksHint')}
            value={values.tasks}
            onChange={(v) => set('tasks', v)}
            rows={3}
            maxLength={LIMITS.tasks}
            error={error('tasks')}
          />
          <TextField
            id="p-skills"
            name="desiredSkills"
            label={f('desiredSkills')}
            hint={f('desiredSkillsHint')}
            value={values.desiredSkills}
            onChange={(e) => set('desiredSkills', e.target.value)}
            autoComplete="off"
            error={error('desiredSkills')}
          />

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <TextField
              id="p-hours"
              name="workloadHours"
              label={f('workloadHours')}
              hint={f('workloadHint')}
              type="number"
              inputMode="numeric"
              min={LIMITS.hoursMin}
              max={LIMITS.hoursMax}
              step={1}
              value={values.workloadHours}
              onChange={(e) => set('workloadHours', e.target.value)}
              error={error('workloadHours')}
            />
            <SelectField
              id="p-duration"
              label={f('durationWeeks')}
              placeholder={f('chooseDuration')}
              value={values.durationWeeks}
              onChange={(v) => set('durationWeeks', v)}
              options={DURATION_WEEKS.map((n) => ({
                value: String(n),
                label: f('weeks', { count: n }),
              }))}
              error={error('durationWeeks')}
            />
            <TextField
              id="p-deadline"
              name="deadline"
              label={f('deadline')}
              hint={f('deadlineHint')}
              type="date"
              min={today}
              value={values.deadline}
              onChange={(e) => set('deadline', e.target.value)}
              error={error('deadline')}
            />
            <TextField
              id="p-start"
              name="startDate"
              label={f('startDate')}
              hint={f('startDateHint')}
              type="date"
              min={values.deadline || today}
              value={values.startDate}
              onChange={(e) => set('startDate', e.target.value)}
              error={error('startDate')}
            />
            <SelectField
              id="p-workmode"
              label={f('workMode')}
              placeholder={f('chooseWorkMode')}
              value={workMode}
              onChange={(v) => set('workMode', v)}
              options={WORK_MODES.map((mode) => ({
                value: mode,
                label: f(`workModeOption.${mode}`),
              }))}
              error={error('workMode')}
            />
            {workMode && workMode !== 'remote' && (
              <TextField
                id="p-location"
                name="location"
                label={f('location')}
                hint={f('locationHint')}
                value={values.location}
                onChange={(e) => set('location', e.target.value)}
                maxLength={LIMITS.location}
                autoComplete="address-level2"
                error={error('location')}
              />
            )}
          </div>

          <AreaField
            id="p-deliverable"
            label={f('deliverable')}
            hint={f('deliverableHint')}
            value={values.deliverable}
            onChange={(v) => set('deliverable', v)}
            rows={3}
            maxLength={LIMITS.deliverable}
            error={error('deliverable')}
          />

          <fieldset className="grid min-w-0 gap-3">
            <legend className="mb-3 text-base font-semibold">{f('paidOrUnpaid')}</legend>
            <RadioGroup
              value={paid}
              onValueChange={(v) => set('paidOrUnpaid', v)}
              aria-invalid={error('paidOrUnpaid') ? true : undefined}
              aria-describedby={error('paidOrUnpaid') ? 'p-paid-error' : 'p-paid-hint'}
              className="grid gap-3 sm:grid-cols-2"
            >
              {PAY_CHOICES.map((choice) => (
                <label
                  key={choice}
                  htmlFor={`p-paid-${choice}`}
                  className={cn(
                    'grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] gap-3.5 rounded-item border-[1.5px] border-line bg-surface p-4 transition-colors',
                    'has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-tint',
                    error('paidOrUnpaid') && 'border-destructive',
                  )}
                >
                  <RadioGroupItem id={`p-paid-${choice}`} value={choice} className="mt-0.5" />
                  <span className="grid content-start gap-1">
                    <b className="inline-flex items-center gap-2 font-semibold">
                      {choice === 'paid' ? (
                        <CoinsIcon aria-hidden="true" className="size-5 text-primary" />
                      ) : (
                        <HeartHandshakeIcon aria-hidden="true" className="size-5 text-primary" />
                      )}
                      {f(`payOption.${choice}`)}
                    </b>
                    <small className="text-[0.85rem] text-muted-foreground">
                      {f(`payBody.${choice}`)}
                    </small>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {error('paidOrUnpaid') && (
              <p id="p-paid-error" className="text-[0.88rem] font-semibold text-destructive">
                {error('paidOrUnpaid')}
              </p>
            )}
            {paid === 'unpaid' && (
              <AreaField
                id="p-benefit"
                label={f('unpaidBenefit')}
                hint={f('unpaidBenefitHint')}
                placeholder={f('unpaidBenefitPlaceholder')}
                value={values.unpaidBenefit}
                onChange={(v) => set('unpaidBenefit', v)}
                rows={2}
                maxLength={LIMITS.unpaidBenefit}
                error={error('unpaidBenefit')}
              />
            )}
            <p id="p-paid-hint" className="text-[0.85rem] text-muted-foreground">
              {f('payNote')}
            </p>
          </fieldset>

          <div className="grid gap-2">
            <p className="text-[0.9rem] leading-snug font-semibold">{f('attachmentsOptional')}</p>
            <BriefFilesField
              files={files}
              onChange={changeFiles}
              disabled={sending}
              error={error('attachments')}
            />
          </div>

          <div className="grid gap-3 border-t-[1.5px] border-line pt-5">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                disabled={!canSend || sending}
                aria-describedby={!canSend ? 'p-send-locked' : undefined}
              >
                <SendIcon aria-hidden="true" />
                {t('send')}
              </Button>
              <Button type="button" variant="secondary" onClick={saveDraft} disabled={sending}>
                {t('saveDraft')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPreviewOpen(true)}
                disabled={sending}
              >
                <EyeIcon aria-hidden="true" />
                {t('preview')}
              </Button>
            </div>
            {!canSend && (
              <p id="p-send-locked" className="text-[0.85rem] text-muted-foreground">
                {t('sendLocked')}
              </p>
            )}
            <p
              role="status"
              aria-live="polite"
              className={cn(
                'inline-flex items-center gap-2 text-[0.85rem] text-muted-foreground',
                save.kind === 'error' && 'font-semibold text-destructive',
              )}
            >
              {save.kind === 'saving' && (
                <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
              )}
              {save.kind === 'saved' && (
                <CircleCheckIcon aria-hidden="true" className="size-4 text-success" />
              )}
              {saveText}
            </p>
          </div>
        </form>
      </Card>

      <Card className="md:sticky md:top-24">
        <h2 className="text-base font-semibold">{t('nextTitle')}</h2>
        <ol className="grid gap-1">
          {([1, 2, 3, 4] as const).map((n) => (
            <li key={n} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 py-[7px]">
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full border-[1.5px] border-input bg-surface text-[0.8rem] font-bold text-muted-foreground"
              >
                {n}
              </span>
              <span className="grid gap-0.5">
                <b className="font-semibold">{t(`next${n}Title`)}</b>
                <small className="text-[0.85rem] text-muted-foreground">{t(`next${n}Body`)}</small>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-[0.85rem] text-muted-foreground">{t('reviewPromise')}</p>
      </Card>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent closeLabel={t('close')} className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('previewTitle')}</DialogTitle>
            <DialogDescription>{t('previewLede')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 rounded-item border-[1.5px] border-line p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-3">
              <CompanyAvatar name={companyName} logoUrl={companyLogoUrl} />
              <div className="min-w-0">
                <p className="text-lg leading-tight font-semibold [overflow-wrap:anywhere]">
                  {values.title.trim() || t('untitled')}
                </p>
                <p className="text-[0.88rem] text-muted-foreground">{companyName}</p>
              </div>
            </div>
            <ProjectDetails
              project={{
                desiredSkills: preview.desiredSkills,
                workloadHours: preview.workloadHours,
                durationWeeks: preview.durationWeeks,
                description: values.description,
                tasks: values.tasks,
                startDate: values.startDate || null,
                deadline: values.deadline || null,
                workMode: (workMode || null) as WorkMode | null,
                location: values.location,
                deliverable: values.deliverable,
                paidOrUnpaid: (paid || null) as PayChoice | null,
                unpaidBenefit: values.unpaidBenefit,
              }}
            />
          </div>
          <p className="text-[0.85rem] text-muted-foreground">{t('previewFiles')}</p>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={(open) => !sending && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{t('confirmBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={sending}>
                {t('confirmCancel')}
              </Button>
            </DialogClose>
            <Button type="button" onClick={send} disabled={sending}>
              {sending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
              {sending ? t('sending') : t('confirmSend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-[0.88rem] font-semibold text-destructive">
      {message}
    </p>
  )
}

function AreaField({
  id,
  label,
  hint,
  error,
  value,
  onChange,
  ...props
}: {
  id: string
  label: string
  hint?: ReactNode
  error?: string
  value: string
  onChange: (value: string) => void
  rows?: number
  maxLength?: number
  placeholder?: string
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}

function SelectField({
  id,
  label,
  placeholder,
  value,
  onChange,
  options,
  error,
}: {
  id: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  error?: string
}) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  )
}
