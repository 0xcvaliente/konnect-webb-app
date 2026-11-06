'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type FormEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { toast } from 'sonner'

import { TextField } from '@/components/app/AuthForm'
import { Banner } from '@/components/app/Banner'
import { type CvInfo, CvField } from '@/components/app/CvField'
import { SharingChoices } from '@/components/app/SharingChoices'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { saveProfileAction, savePrivacyAction, setCvAction } from '@/lib/students/actions'
import {
  type FieldProblem,
  IDLE,
  INTEREST_KEYS,
  LIMITS,
  type ProfileField,
  type ProfileFormState,
  PROJECT_TYPE_KEYS,
  SHARE_KEYS,
  type ShareKey,
  YEARS,
} from '@/lib/students/fields'
import { cn } from '@/lib/utils'

export type ProfileValues = {
  name: string
  school: string
  programme: string
  year: string
  pitch: string
  skills: string
  interests: string[]
  preferredProjectTypes: string[]
  experience: string
  highlights: string
  contactEmail: string
  phone: string
}

/** The message for a field problem the server reported. */
function useProblemText() {
  const f = useTranslations('StudentFields')
  return (field: ProfileField, problem: FieldProblem | undefined): string | undefined => {
    if (!problem) return undefined
    if (problem === 'required') {
      if (field === 'interests') return f('errors.requiredChoice')
      if (field === 'year') return f('errors.requiredOne')
      return f('errors.required')
    }
    if (problem === 'too_many') return f('errors.tooManySkills', { max: LIMITS.skills })
    if (problem === 'too_long') {
      if (field === 'skills') return f('errors.skillTooLong', { max: LIMITS.skill })
      const max = LIMITS[field as keyof typeof LIMITS] ?? 0
      return f('errors.tooLong', { max })
    }
    if (field === 'contactEmail') return f('errors.emailInvalid')
    if (field === 'phone') return f('errors.phoneInvalid')
    if (field === 'year') return f('errors.yearInvalid')
    return f('errors.cvInvalid')
  }
}

/** A form-level error banner for a failed save. */
function SaveError({ state }: { state: ProfileFormState }) {
  const t = useTranslations('Profile')
  if (state.status !== 'error') return null
  const message = state.fields
    ? t('errors.fix')
    : state.error === 'forbidden'
      ? t('errors.forbidden')
      : t('errors.generic')
  return (
    <Banner tone="bad" role="alert">
      <p>{message}</p>
    </Banner>
  )
}

/**
 * The profile page's three parts (mockup "Profile and CV"): the "About you" form with the CV under
 * it, and beside it what a company may see. Each part saves on its own through a Server Action.
 * Forms are sent with startTransition so React does not reset the fields after a save.
 */
export function ProfileForms({
  values,
  cv,
  privacy,
}: {
  values: ProfileValues
  cv: CvInfo | null
  privacy: Record<ShareKey, boolean>
}) {
  return (
    <div className="grid items-start gap-6 sm:gap-[26px] md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 gap-6 sm:gap-[26px]">
        <AboutForm values={values} />
        <CvCard cv={cv} />
      </div>
      <SharingForm privacy={privacy} />
    </div>
  )
}

function AboutForm({ values }: { values: ProfileValues }) {
  const t = useTranslations('Profile')
  const f = useTranslations('StudentFields')
  const problemText = useProblemText()
  const [state, dispatch, pending] = useActionState(saveProfileAction, IDLE)
  const formRef = useRef<HTMLFormElement>(null)
  const [year, setYear] = useState(values.year)

  const error = (field: ProfileField) =>
    state.status === 'error' ? problemText(field, state.fields?.[field]) : undefined

  useEffect(() => {
    if (state.status === 'done') toast(t('saved'))
    if (state.status === 'error' && state.fields) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [state, t])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    startTransition(() => dispatch(form))
  }

  return (
    <Card>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="grid gap-5">
        <CardHeader>
          <CardTitle>{t('aboutTitle')}</CardTitle>
        </CardHeader>
        <SaveError state={state} />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="p-name"
            name="name"
            label={f('name')}
            defaultValue={values.name}
            autoComplete="name"
            error={error('name')}
          />
          <TextField
            id="p-school"
            name="school"
            label={f('school')}
            defaultValue={values.school}
            autoComplete="organization"
            error={error('school')}
          />
          <TextField
            id="p-programme"
            name="programme"
            label={f('programme')}
            defaultValue={values.programme}
            error={error('programme')}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="p-year">{f('year')}</Label>
            <Select name="year" value={year} onValueChange={setYear}>
              <SelectTrigger
                id="p-year"
                aria-invalid={error('year') ? true : undefined}
                aria-describedby={error('year') ? 'p-year-error' : undefined}
              >
                <SelectValue placeholder={f('chooseYear')} />
              </SelectTrigger>
              <SelectContent>
                {YEARS.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {f(`yearOption.${y}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError id="p-year-error" message={error('year')} />
          </div>
        </div>

        <TextAreaField
          id="p-pitch"
          name="pitch"
          label={f('pitch')}
          hint={f('pitchHint')}
          defaultValue={values.pitch}
          rows={3}
          error={error('pitch')}
        />
        <TextField
          id="p-skills"
          name="skills"
          label={f('skills')}
          hint={f('skillsHint')}
          defaultValue={values.skills}
          autoComplete="off"
          error={error('skills')}
        />
        <ChipGroup
          id="p-interests"
          name="interests"
          legend={f('interests')}
          options={INTEREST_KEYS.map((k) => ({ value: k, label: f(`interest.${k}`) }))}
          defaultValues={values.interests}
          error={error('interests')}
        />
        <ChipGroup
          id="p-types"
          name="preferredProjectTypes"
          legend={f('projectTypes')}
          options={PROJECT_TYPE_KEYS.map((k) => ({ value: k, label: f(`projectType.${k}`) }))}
          defaultValues={values.preferredProjectTypes}
          error={error('preferredProjectTypes')}
        />

        <h3 className="pt-2 text-base font-semibold">{t('moreTitle')}</h3>
        <TextAreaField
          id="p-experience"
          name="experience"
          label={f('experience')}
          hint={f('experienceHint')}
          defaultValue={values.experience}
          rows={3}
          error={error('experience')}
        />
        <TextAreaField
          id="p-highlights"
          name="highlights"
          label={f('highlights')}
          hint={f('highlightsHint')}
          defaultValue={values.highlights}
          rows={3}
          error={error('highlights')}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="p-contact-email"
            name="contactEmail"
            type="email"
            inputMode="email"
            label={f('contactEmail')}
            hint={f('contactEmailHint')}
            defaultValue={values.contactEmail}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            error={error('contactEmail')}
          />
          <TextField
            id="p-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            label={f('phone')}
            hint={f('phoneHint')}
            defaultValue={values.phone}
            autoComplete="tel"
            error={error('phone')}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {pending ? t('saving') : t('save')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function CvCard({ cv: initial }: { cv: CvInfo | null }) {
  const t = useTranslations('Cv')
  const f = useTranslations('StudentFields')
  const [cv, setCv] = useState(initial)
  const [error, setError] = useState<string | undefined>()
  const [pending, start] = useTransition()

  const change = (next: CvInfo | null) =>
    new Promise<void>((resolve) => {
      start(async () => {
        const form = new FormData()
        form.set('cv', next ? String(next.id) : 'none')
        const result = await setCvAction(IDLE, form)
        if (result.status === 'done') {
          setCv(next)
          setError(undefined)
          toast(next ? t('saved') : t('removed'))
        } else {
          setError(result.fields?.cv ? f('errors.cvInvalid') : t('errors.generic'))
        }
        resolve()
      })
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        {!cv && <CardDescription>{t('noCvNote')}</CardDescription>}
      </CardHeader>
      <CvField cv={cv} onChange={change} busy={pending} error={error} />
    </Card>
  )
}

function SharingForm({ privacy }: { privacy: Record<ShareKey, boolean> }) {
  const t = useTranslations('Profile')
  const f = useTranslations('StudentFields')
  const [state, dispatch, pending] = useActionState(savePrivacyAction, IDLE)
  const [values, setValues] = useState(privacy)
  const count = SHARE_KEYS.filter((k) => values[k]).length

  useEffect(() => {
    if (state.status === 'done') toast(t('sharingSaved'))
  }, [state, t])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData()
    for (const key of SHARE_KEYS) if (values[key]) form.set(key, 'on')
    startTransition(() => dispatch(form))
  }

  return (
    <Card className="md:sticky md:top-24">
      <form onSubmit={onSubmit} className="grid gap-4">
        <CardHeader>
          <CardTitle>{t('sharingTitle')}</CardTitle>
          <CardDescription>{f('sharingExplain')}</CardDescription>
        </CardHeader>
        <SaveError state={state} />
        <fieldset className="grid gap-1">
          <legend className="sr-only">{f('sharingLegend')}</legend>
          <SharingChoices
            values={values}
            onChange={(key, on) => setValues((v) => ({ ...v, [key]: on }))}
          />
        </fieldset>
        <p className="text-[0.85rem] text-muted-foreground">{f('sharingLater')}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span aria-live="polite" className="text-[0.88rem] text-muted-foreground">
            {t('sharedCount', { count })}
          </span>
          <Button type="submit" variant="normal" disabled={pending}>
            {pending && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {pending ? t('saving') : t('saveSharing')}
          </Button>
        </div>
      </form>
    </Card>
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

function TextAreaField({
  id,
  name,
  label,
  hint,
  error,
  ...props
}: {
  id: string
  name: string
  label: string
  hint?: ReactNode
  error?: string
  defaultValue?: string
  rows?: number
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name={name}
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

/** Pill chips that work as checkboxes (konnected-design-system: chip, pressed = tint). */
function ChipGroup({
  id,
  name,
  legend,
  options,
  defaultValues,
  error,
}: {
  id: string
  name: string
  legend: string
  options: { value: string; label: string }[]
  defaultValues: string[]
  error?: string
}) {
  return (
    <fieldset className="grid gap-2" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-2 text-[0.9rem] leading-snug font-semibold">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center rounded-full border-[1.5px] border-line bg-surface px-4 text-[0.88rem] font-medium text-foreground transition-colors select-none hover:bg-surface-2 sm:min-h-9',
              'has-[:checked]:border-transparent has-[:checked]:bg-tint has-[:checked]:text-tint-foreground',
              'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary',
            )}
          >
            <input
              type="checkbox"
              name={name}
              value={option.value}
              defaultChecked={defaultValues.includes(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  )
}
