'use client'

import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type KeyboardEvent,
  type ReactNode,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from 'react'

import { Banner } from '@/components/app/Banner'
import { type CvInfo, CvField, deleteCv } from '@/components/app/CvField'
import { Brand } from '@/components/app/LogoMark'
import { SharingChoices } from '@/components/app/SharingChoices'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/i18n/navigation'
import { completeOnboardingAction } from '@/lib/students/actions'
import {
  IDLE,
  INTEREST_KEYS,
  LIMITS,
  type ProfileField,
  PROJECT_TYPE_KEYS,
  SCHOOL_KEYS,
  SHARE_KEYS,
  type ShareKey,
  splitSkills,
  YEARS,
} from '@/lib/students/fields'
import { cn } from '@/lib/utils'

/**
 * Student onboarding, one question per screen ("Final pass" mockup, Student onboarding): a
 * welcome, ten questions, then a summary. Answers stay in the browser until the last step, which
 * sends everything to completeOnboardingAction in one go; the server checks every answer again.
 * The CV is uploaded when it is picked (the server keeps it unused until the profile is saved).
 */

const QUESTIONS = [
  'name',
  'school',
  'programme',
  'year',
  'pitch',
  'skills',
  'interests',
  'projectTypes',
  'cv',
  'privacy',
] as const
type Question = (typeof QUESTIONS)[number]
type Step = 'welcome' | Question | 'done'
const STEPS: Step[] = ['welcome', ...QUESTIONS, 'done']

/** Where a server error on a field sends the student back to. */
const STEP_OF: Partial<Record<ProfileField, Question>> = {
  name: 'name',
  school: 'school',
  programme: 'programme',
  year: 'year',
  pitch: 'pitch',
  skills: 'skills',
  interests: 'interests',
  preferredProjectTypes: 'projectTypes',
  cv: 'cv',
}

const KEYS = 'ABCDEFGH'

type SchoolChoice = (typeof SCHOOL_KEYS)[number] | 'other' | ''

type Answers = {
  name: string
  school: SchoolChoice
  schoolOther: string
  programme: string
  year: number | null
  pitch: string
  skills: string
  interests: string[]
  projectTypes: string[]
  cv: CvInfo | null
  privacy: Record<ShareKey, boolean>
}

const EMPTY: Answers = {
  name: '',
  school: '',
  schoolOther: '',
  programme: '',
  year: null,
  pitch: '',
  skills: '',
  interests: [],
  projectTypes: [],
  cv: null,
  privacy: Object.fromEntries(SHARE_KEYS.map((k) => [k, false])) as Record<ShareKey, boolean>,
}

export function StudentOnboarding({ locale }: { locale: string }) {
  const t = useTranslations('Onboarding')
  const f = useTranslations('StudentFields')
  const tc = useTranslations('Cv')
  const [state, dispatch, pending] = useActionState(completeOnboardingAction, IDLE)
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState<'in' | 'back'>('in')
  const [answers, setAnswers] = useState<Answers>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [cvBusy, setCvBusy] = useState(false)
  const questionRef = useRef<HTMLDivElement>(null)
  const firstRender = useRef(true)

  const step: Step = state.status === 'done' ? 'done' : STEPS[index]!
  const number = QUESTIONS.indexOf(step as Question) + 1
  const total = QUESTIONS.length
  const progress = step === 'done' ? 100 : number > 0 ? ((number - 1) / total) * 100 : 0

  const set = <K extends keyof Answers>(key: K, value: Answers[K]) => {
    setAnswers((a) => ({ ...a, [key]: value }))
    setError(null)
  }

  const schoolText =
    answers.school === 'other'
      ? answers.schoolOther.trim()
      : answers.school
        ? f(`schoolOption.${answers.school}`)
        : ''

  /** The same rules as the server, for a quick answer. The server decides. */
  const problem = (q: Step): string | null => {
    const tooLong = (value: string, max: number) =>
      value.trim().length > max ? f('errors.tooLong', { max }) : null
    switch (q) {
      case 'name':
        return answers.name.trim() ? tooLong(answers.name, LIMITS.name) : f('errors.required')
      case 'school':
        if (!answers.school) return f('errors.requiredOne')
        return schoolText ? tooLong(schoolText, LIMITS.school) : f('errors.required')
      case 'programme':
        return answers.programme.trim()
          ? tooLong(answers.programme, LIMITS.programme)
          : f('errors.required')
      case 'year':
        return answers.year ? null : f('errors.requiredOne')
      case 'pitch':
        return tooLong(answers.pitch, LIMITS.pitch)
      case 'skills': {
        const skills = splitSkills(answers.skills)
        if (skills.length > LIMITS.skills) return f('errors.tooManySkills', { max: LIMITS.skills })
        return skills.some((s) => s.length > LIMITS.skill)
          ? f('errors.skillTooLong', { max: LIMITS.skill })
          : null
      }
      case 'interests':
        return answers.interests.length ? null : f('errors.requiredChoice')
      default:
        return null
    }
  }

  const go = (to: number) => {
    setDirection(to < index ? 'back' : 'in')
    setIndex(to)
    setError(null)
  }

  const submit = () => {
    const form = new FormData()
    form.set('name', answers.name)
    form.set('school', schoolText)
    form.set('programme', answers.programme)
    form.set('year', String(answers.year ?? ''))
    form.set('pitch', answers.pitch)
    form.set('skills', answers.skills)
    answers.interests.forEach((v) => form.append('interests', v))
    answers.projectTypes.forEach((v) => form.append('preferredProjectTypes', v))
    form.set('cv', answers.cv ? String(answers.cv.id) : 'none')
    for (const key of SHARE_KEYS) if (answers.privacy[key]) form.set(key, 'on')
    form.set('locale', locale)
    startTransition(() => dispatch(form))
  }

  const next = () => {
    if (step === 'done' || pending || cvBusy) return
    const message = problem(step)
    if (message) {
      setError(message)
      return
    }
    if (step === 'privacy') submit()
    else go(index + 1)
  }

  const previous = () => {
    if (index > 0 && step !== 'done' && !pending) go(index - 1)
  }

  // A server answer: go back to the first question with a problem, or show the error.
  useEffect(() => {
    if (state.status !== 'error') return
    const field = Object.keys(state.fields ?? {})[0] as ProfileField | undefined
    const target = field ? STEP_OF[field] : undefined
    if (target) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a server answer
      go(STEPS.indexOf(target))
      setError(problem(target) ?? f('errors.cvInvalid'))
    } else {
      setError(
        t(
          `errors.${state.error === 'exists' ? 'exists' : state.error === 'forbidden' ? 'forbidden' : 'generic'}`,
        ),
      )
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- once per server answer

  // Move focus to the new question so it is read out, but not on the first screen.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const root = questionRef.current
    const field = root?.querySelector<HTMLElement>('[data-autofocus]')
    ;(field ?? root)?.focus({ preventScroll: true })
  }, [step])

  // Enter moves on (not in the pitch box, where it makes a new line); A to H pick an option.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (event.key === 'Enter' && !event.shiftKey) {
      if (target.closest('button, a, textarea, [role=checkbox]')) return
      event.preventDefault()
      next()
      return
    }
    if (target.matches('input, textarea') || event.metaKey || event.ctrlKey || event.altKey) return
    const at = KEYS.indexOf(event.key.toUpperCase())
    if (event.key.length !== 1 || at < 0) return
    const option = questionRef.current?.querySelectorAll<HTMLButtonElement>('[data-option]')[at]
    if (option) {
      event.preventDefault()
      option.click()
    }
  }

  const toggle = (key: 'interests' | 'projectTypes', value: string) =>
    set(
      key,
      answers[key].includes(value)
        ? answers[key].filter((v) => v !== value)
        : [...answers[key], value],
    )

  const changeCv = async (cv: CvInfo | null) => {
    const old = answers.cv
    set('cv', cv)
    if (old && old.id !== cv?.id) {
      setCvBusy(true)
      await deleteCv(old.id)
      setCvBusy(false)
    }
  }

  const titleId = `ob-${step}-title`
  const helpId = `ob-${step}-help`
  const errorId = `ob-${step}-error`
  const described = [t.has(`help.${step}`) ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ')

  const textField = (key: 'name' | 'programme', autoComplete: string, maxLength: number) => (
    <Input
      data-autofocus
      id={`ob-${key}`}
      value={answers[key]}
      onChange={(e) => set(key, e.target.value)}
      autoComplete={autoComplete}
      maxLength={maxLength + 20}
      placeholder={t('placeholder')}
      aria-labelledby={titleId}
      aria-describedby={described || undefined}
      aria-invalid={error ? true : undefined}
      className={UNDERLINE}
    />
  )

  const options = (
    items: { value: string; label: string }[],
    selected: (value: string) => boolean,
    onPick: (value: string) => void,
    columns = false,
  ) => (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={described || undefined}
      className={cn('grid max-w-[440px] gap-2', columns && 'sm:max-w-[620px] sm:grid-cols-2')}
    >
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          data-option
          aria-pressed={selected(item.value)}
          onClick={() => onPick(item.value)}
          className="group flex min-h-12 cursor-pointer items-center gap-3 rounded-full border border-[color-mix(in_srgb,var(--primary)_45%,transparent)] bg-[color-mix(in_srgb,var(--primary)_7%,var(--surface))] py-2 pr-[18px] pl-2.5 text-left text-[1.05rem] leading-snug font-medium text-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_15%,var(--surface))] aria-pressed:border-primary aria-pressed:bg-[color-mix(in_srgb,var(--primary)_14%,var(--surface))] aria-pressed:shadow-[inset_0_0_0_1px_var(--primary)]"
        >
          <kbd
            aria-hidden="true"
            className="inline-grid h-7 min-w-7 shrink-0 place-items-center rounded-full border border-[color-mix(in_srgb,var(--primary)_55%,transparent)] bg-surface px-1.5 font-sans text-[0.8rem] font-semibold text-primary group-aria-pressed:border-primary group-aria-pressed:bg-primary group-aria-pressed:text-primary-foreground"
          >
            {KEYS[i]}
          </kbd>
          <span className="min-w-0 flex-1">{item.label}</span>
          <CheckIcon
            aria-hidden="true"
            className="size-[18px] shrink-0 text-primary opacity-0 group-aria-pressed:opacity-100"
          />
        </button>
      ))}
    </div>
  )

  let field: ReactNode = null
  switch (step) {
    case 'name':
      field = textField('name', 'name', LIMITS.name)
      break
    case 'programme':
      field = textField('programme', 'off', LIMITS.programme)
      break
    case 'school':
      field = (
        <div className="grid gap-4">
          {options(
            [
              ...SCHOOL_KEYS.map((k) => ({ value: k, label: f(`schoolOption.${k}`) })),
              { value: 'other', label: t('otherSchool') },
            ],
            (v) => answers.school === v,
            (v) => set('school', v as SchoolChoice),
          )}
          {answers.school === 'other' && (
            <div className="grid max-w-[440px] gap-1.5">
              <Label htmlFor="ob-school-other">{t('otherSchoolLabel')}</Label>
              <Input
                id="ob-school-other"
                value={answers.schoolOther}
                onChange={(e) => set('schoolOther', e.target.value)}
                autoComplete="organization"
                maxLength={LIMITS.school + 20}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
          )}
        </div>
      )
      break
    case 'year':
      field = options(
        YEARS.map((y) => ({ value: String(y), label: f(`yearOption.${y}`) })),
        (v) => answers.year === Number(v),
        (v) => set('year', Number(v)),
      )
      break
    case 'pitch':
      field = (
        <Textarea
          data-autofocus
          id="ob-pitch"
          value={answers.pitch}
          onChange={(e) => set('pitch', e.target.value)}
          rows={4}
          maxLength={LIMITS.pitch + 50}
          placeholder={t('placeholder')}
          aria-labelledby={titleId}
          aria-describedby={described || undefined}
          aria-invalid={error ? true : undefined}
          className={cn(UNDERLINE, 'min-h-28 resize-none text-[1.25rem] sm:text-[1.4rem]')}
        />
      )
      break
    case 'skills':
      field = (
        <Input
          data-autofocus
          id="ob-skills"
          value={answers.skills}
          onChange={(e) => set('skills', e.target.value)}
          autoComplete="off"
          placeholder={t('placeholder')}
          aria-labelledby={titleId}
          aria-describedby={described || undefined}
          aria-invalid={error ? true : undefined}
          className={UNDERLINE}
        />
      )
      break
    case 'interests':
      field = options(
        INTEREST_KEYS.map((k) => ({ value: k, label: f(`interest.${k}`) })),
        (v) => answers.interests.includes(v),
        (v) => toggle('interests', v),
        true,
      )
      break
    case 'projectTypes':
      field = options(
        PROJECT_TYPE_KEYS.map((k) => ({ value: k, label: f(`projectType.${k}`) })),
        (v) => answers.projectTypes.includes(v),
        (v) => toggle('projectTypes', v),
      )
      break
    case 'cv':
      field = (
        <div className="grid max-w-[560px] gap-4">
          <CvField cv={answers.cv} onChange={changeCv} busy={cvBusy} />
          {!answers.cv && (
            <Banner tone="info">
              <p>{tc('noCvNote')}</p>
            </Banner>
          )}
        </div>
      )
      break
    case 'privacy':
      field = (
        <fieldset className="grid max-w-[560px] gap-3">
          <legend className="sr-only">{f('sharingLegend')}</legend>
          <SharingChoices
            values={answers.privacy}
            onChange={(key, on) => set('privacy', { ...answers.privacy, [key]: on })}
          />
        </fieldset>
      )
      break
  }

  return (
    <div
      className="relative flex min-h-dvh flex-col bg-background"
      onKeyDown={onKeyDown}
      aria-label={t('label')}
      role="region"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1.5 bg-[color-mix(in_srgb,var(--primary)_16%,transparent)]"
      >
        <i
          className="block h-full bg-data transition-[width] duration-350 ease-out motion-reduce:transition-none"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-4 pt-[18px] sm:px-8 sm:pt-[22px]">
        <Link href="/" className="inline-flex min-h-11 items-center rounded-full no-underline">
          <Brand className="text-foreground" />
        </Link>
        <span
          aria-live="polite"
          className="text-[0.88rem] text-muted-foreground [font-variant-numeric:tabular-nums]"
        >
          {number > 0 ? t('count', { n: number, total }) : step === 'done' ? t('done') : ''}
        </span>
      </div>

      <main
        id="main"
        className="grid flex-1 items-center px-4 pt-7 pb-24 sm:px-8 sm:pt-10 sm:pb-[104px]"
      >
        <div
          key={step}
          ref={questionRef}
          tabIndex={-1}
          className={cn(
            'mx-auto grid w-full max-w-[680px] gap-5 outline-none',
            'animate-in fade-in duration-400 ease-out motion-reduce:animate-none',
            direction === 'in' ? 'slide-in-from-bottom-7' : 'slide-in-from-top-7',
          )}
        >
          {step === 'welcome' && (
            <>
              <h1 className={BIG_TITLE}>{t('welcomeTitle')}</h1>
              <p className={HELP}>{t('welcomeBody', { total })}</p>
              <div className="flex flex-wrap items-center gap-3.5">
                <Button size="lg" onClick={next}>
                  {t('start')}
                </Button>
                <EnterHint />
              </div>
            </>
          )}

          {step === 'done' && <Summary answers={answers} schoolText={schoolText} />}

          {number > 0 && (
            <>
              <h2 id={titleId} className={TITLE}>
                <span
                  aria-hidden="true"
                  className="mr-2.5 inline-flex items-center gap-1 align-[0.25em] text-base font-semibold text-primary"
                >
                  {number}
                  <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </span>
                {t(`q.${step}`)}
              </h2>
              {t.has(`help.${step}`) && (
                <p id={helpId} className={HELP}>
                  {t(`help.${step}`)}
                </p>
              )}
              {step === 'privacy' && (
                <div id={helpId} className="grid gap-2">
                  <p className={HELP}>{f('sharingExplain')}</p>
                  <p className="text-[0.92rem] text-muted-foreground">{f('sharingLater')}</p>
                </div>
              )}
              {field}
              {error && (
                <p
                  id={errorId}
                  role="alert"
                  className="flex items-center gap-1.5 text-[0.92rem] font-semibold text-destructive"
                >
                  <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
                  {error}
                  {state.error === 'exists' && (
                    <Link href="/student/profile" className="ml-1 text-primary">
                      {t('toProfile')}
                    </Link>
                  )}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3.5">
                <Button size="lg" onClick={next} disabled={pending || cvBusy}>
                  {pending ? (
                    <>
                      <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                      {t('saving')}
                    </>
                  ) : (
                    <>
                      {step === 'privacy' ? t('finish') : t('ok')}
                      <CheckIcon aria-hidden="true" />
                    </>
                  )}
                </Button>
                <EnterHint />
              </div>
            </>
          )}
        </div>
      </main>

      {step !== 'done' && (
        <div className="absolute right-4 bottom-4 flex gap-0.5 sm:right-7 sm:bottom-6">
          <button
            type="button"
            onClick={previous}
            disabled={index === 0 || pending}
            aria-label={t('previous')}
            className={cn(NAV_BUTTON, 'rounded-l-full')}
          >
            <ChevronUpIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.4} />
          </button>
          <button
            type="button"
            onClick={next}
            disabled={pending}
            aria-label={t('next')}
            className={cn(NAV_BUTTON, 'rounded-r-full')}
          >
            <ChevronDownIcon aria-hidden="true" className="size-[18px]" strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  )
}

const UNDERLINE =
  'min-h-12 rounded-none border-0 border-b-2 border-[color-mix(in_srgb,var(--primary)_35%,transparent)] bg-transparent px-0 py-2 text-[1.55rem] leading-snug placeholder:text-[color-mix(in_srgb,var(--ink-2)_70%,transparent)] focus-visible:border-primary focus-visible:outline-none sm:min-h-14 sm:text-[1.9rem] aria-invalid:border-destructive'
const TITLE =
  'text-[1.55rem] leading-[1.3] font-medium tracking-[-0.01em] text-balance text-foreground sm:text-[1.9rem]'
const BIG_TITLE =
  'text-[2.1rem] leading-[1.15] font-semibold tracking-[-0.015em] text-balance text-foreground sm:text-[2.6rem]'
const HELP = 'max-w-[56ch] text-[1.05rem] text-muted-foreground'
const NAV_BUTTON =
  'grid h-10 w-11 cursor-pointer place-items-center bg-primary text-primary-foreground transition-opacity disabled:cursor-default disabled:opacity-40'

function EnterHint() {
  const t = useTranslations('Onboarding')
  return (
    <span className="hidden text-[0.85rem] text-muted-foreground sm:inline">
      {t.rich('pressEnter', { b: (c) => <b>{c}</b> })}
    </span>
  )
}

function Summary({ answers, schoolText }: { answers: Answers; schoolText: string }) {
  const t = useTranslations('Onboarding')
  const f = useTranslations('StudentFields')
  const tc = useTranslations('Cv')
  const none = t('notAnswered')
  const shared = SHARE_KEYS.filter((k) => answers.privacy[k]).map((k) => f(`share.${k}`))
  const rows: [string, string][] = [
    [f('name'), answers.name.trim()],
    [f('school'), schoolText],
    [f('programme'), answers.programme.trim()],
    [f('year'), answers.year ? f(`yearOption.${answers.year}`) : none],
    [f('pitch'), answers.pitch.trim() || none],
    [f('skills'), splitSkills(answers.skills).join(', ') || none],
    [f('interests'), answers.interests.map((k) => f(`interest.${k}`)).join(', ') || none],
    [f('projectTypes'), answers.projectTypes.map((k) => f(`projectType.${k}`)).join(', ') || none],
    [tc('title'), answers.cv ? answers.cv.name : tc('noCv')],
  ]
  const first = answers.name.trim().split(/\s+/)[0] ?? ''
  return (
    <>
      <h1 className={BIG_TITLE}>{t('doneTitle', { name: first })}</h1>
      <p className={HELP}>{t('doneBody')}</p>
      <dl className="grid max-w-[560px] grid-cols-1 gap-x-[18px] gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground max-sm:mt-2">{label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground max-sm:mt-2">{t('sharedLabel')}</dt>
        <dd>
          {shared.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {shared.map((label) => (
                <li key={label}>
                  <Badge variant="tag">{label}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <span className="font-medium">{t('nothingShared')}</span>
          )}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/student/profile">{t('toProfile')}</Link>
        </Button>
      </div>
      <p className="text-[0.85rem] text-muted-foreground">{t('doneHint')}</p>
    </>
  )
}
