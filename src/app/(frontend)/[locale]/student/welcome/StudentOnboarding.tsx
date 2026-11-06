'use client'

import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
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
import {
  BIG_TITLE,
  EnterHint,
  HELP,
  OnboardingFrame,
  onboardingKeys,
  OptionList,
  QuestionTitle,
  UNDERLINE,
} from '@/components/app/Onboarding'
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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    onboardingKeys(event, questionRef.current, next)

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
    <OptionList
      items={items}
      selected={selected}
      onPick={onPick}
      labelledBy={titleId}
      describedBy={described}
      columns={columns}
    />
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
    <OnboardingFrame
      label={t('label')}
      progress={progress}
      count={number > 0 ? t('count', { n: number, total }) : step === 'done' ? t('done') : ''}
      stepKey={step}
      direction={direction}
      contentRef={questionRef}
      onKeyDown={onKeyDown}
      onPrevious={previous}
      onNext={next}
      previousDisabled={index === 0 || pending}
      nextDisabled={pending}
      showNav={step !== 'done'}
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
          <QuestionTitle id={titleId} number={number}>
            {t(`q.${step}`)}
          </QuestionTitle>
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
    </OnboardingFrame>
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
