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

import { CompanyAvatar } from '@/components/app/CompanyAvatar'
import { deleteLogo, LogoField, type LogoInfo } from '@/components/app/LogoField'
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
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/i18n/navigation'
import { registerCompanyAction } from '@/lib/companies/actions'
import {
  type CompanyField,
  formatOrgNumber,
  IDLE,
  isValidOrgNumber,
  LIMITS,
  normalizeOrgNumber,
  normalizeWebsite,
  SECTOR_KEYS,
} from '@/lib/companies/fields'
import { cn } from '@/lib/utils'

/**
 * Company onboarding, one question per screen ("Final pass" mockup, Company onboarding, with the
 * questions of the Kanban card): a welcome, eight questions, then a summary. Answers stay in the
 * browser until the last step, which sends everything to registerCompanyAction in one go; the
 * server checks every answer again and registers the company as pending. The logo is uploaded
 * when it is picked (the server keeps it unused until the company is saved).
 */

const QUESTIONS = [
  'name',
  'orgNumber',
  'contactName',
  'contactRole',
  'website',
  'sector',
  'description',
  'logo',
] as const satisfies readonly CompanyField[]
type Question = (typeof QUESTIONS)[number]
type Step = 'welcome' | Question | 'done'
const STEPS: Step[] = ['welcome', ...QUESTIONS, 'done']

type Answers = {
  name: string
  orgNumber: string
  contactName: string
  contactRole: string
  website: string
  sector: string
  description: string
  logo: LogoInfo | null
}

const EMPTY: Answers = {
  name: '',
  orgNumber: '',
  contactName: '',
  contactRole: '',
  website: '',
  sector: '',
  description: '',
  logo: null,
}

type TextQuestion = 'name' | 'orgNumber' | 'contactName' | 'contactRole' | 'website'

export function CompanyOnboarding() {
  const t = useTranslations('CompanyOnboarding')
  const to = useTranslations('Onboarding')
  const f = useTranslations('CompanyFields')
  const [state, dispatch, pending] = useActionState(registerCompanyAction, IDLE)
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState<'in' | 'back'>('in')
  const [answers, setAnswers] = useState<Answers>(EMPTY)
  const [error, setError] = useState<string | null>(null)
  const [logoBusy, setLogoBusy] = useState(false)
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

  /** The same rules as the server, for a quick answer. The server decides. */
  const problem = (q: Step): string | null => {
    const required = (value: string, max: number) =>
      !value.trim()
        ? f('errors.required')
        : value.trim().length > max
          ? f('errors.tooLong', { max })
          : null
    switch (q) {
      case 'name':
        return required(answers.name, LIMITS.name)
      case 'orgNumber':
        if (!answers.orgNumber.trim()) return f('errors.required')
        return isValidOrgNumber(answers.orgNumber) ? null : f('errors.orgNumberInvalid')
      case 'contactName':
        return required(answers.contactName, LIMITS.contactName)
      case 'contactRole':
        return required(answers.contactRole, LIMITS.contactRole)
      case 'website': {
        const value = answers.website.trim()
        if (!value) return null
        if (value.length > LIMITS.website) return f('errors.tooLong', { max: LIMITS.website })
        return normalizeWebsite(value) ? null : f('errors.websiteInvalid')
      }
      case 'sector':
        return answers.sector ? null : f('errors.requiredOne')
      case 'description':
        return required(answers.description, LIMITS.description)
      default:
        return null
    }
  }

  const go = (target: number) => {
    setDirection(target < index ? 'back' : 'in')
    setIndex(target)
    setError(null)
  }

  const submit = () => {
    const form = new FormData()
    form.set('name', answers.name)
    form.set('orgNumber', answers.orgNumber)
    form.set('contactName', answers.contactName)
    form.set('contactRole', answers.contactRole)
    form.set('website', answers.website)
    form.set('sector', answers.sector)
    form.set('description', answers.description)
    form.set('logo', answers.logo ? String(answers.logo.id) : 'none')
    startTransition(() => dispatch(form))
  }

  const next = () => {
    if (step === 'done' || pending || logoBusy) return
    const message = problem(step)
    if (message) {
      setError(message)
      return
    }
    if (step === 'logo') submit()
    else go(index + 1)
  }

  const previous = () => {
    if (index > 0 && step !== 'done' && !pending) go(index - 1)
  }

  // A server answer: go back to the first question with a problem, or show the error.
  useEffect(() => {
    if (state.status !== 'error') return
    const field = Object.keys(state.fields ?? {})[0] as CompanyField | undefined
    if (field && (QUESTIONS as readonly string[]).includes(field)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to a server answer
      go(STEPS.indexOf(field as Question))
      setError(
        problem(field as Question) ??
          (field === 'logo' ? f('errors.logoInvalid') : f('errors.required')),
      )
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
    const target = root?.querySelector<HTMLElement>('[data-autofocus]')
    ;(target ?? root)?.focus({ preventScroll: true })
  }, [step])

  // Enter moves on (not in the description box, where it makes a new line); A to H pick.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    onboardingKeys(event, questionRef.current, next)

  const changeLogo = async (logo: LogoInfo | null) => {
    const old = answers.logo
    set('logo', logo)
    if (old && old.id !== logo?.id) {
      setLogoBusy(true)
      await deleteLogo(old.id)
      setLogoBusy(false)
    }
  }

  const titleId = `cob-${step}-title`
  const helpId = `cob-${step}-help`
  const errorId = `cob-${step}-error`
  const described = [t.has(`help.${step}`) ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ')

  const textField = (
    key: TextQuestion,
    props: { autoComplete: string; maxLength: number; inputMode?: 'numeric' | 'url' | 'text' },
  ) => (
    <Input
      data-autofocus
      id={`cob-${key}`}
      value={answers[key]}
      onChange={(e) => set(key, e.target.value)}
      autoComplete={props.autoComplete}
      inputMode={props.inputMode}
      autoCapitalize={key === 'website' ? 'none' : undefined}
      spellCheck={key === 'website' || key === 'orgNumber' ? false : undefined}
      maxLength={props.maxLength + 20}
      placeholder={key === 'orgNumber' ? '999 123 457' : to('placeholder')}
      aria-labelledby={titleId}
      aria-describedby={described || undefined}
      aria-invalid={error ? true : undefined}
      className={UNDERLINE}
    />
  )

  let field: ReactNode = null
  switch (step) {
    case 'name':
      field = textField('name', { autoComplete: 'organization', maxLength: LIMITS.name })
      break
    case 'orgNumber':
      field = textField('orgNumber', { autoComplete: 'off', maxLength: 11, inputMode: 'numeric' })
      break
    case 'contactName':
      field = textField('contactName', { autoComplete: 'name', maxLength: LIMITS.contactName })
      break
    case 'contactRole':
      field = textField('contactRole', {
        autoComplete: 'organization-title',
        maxLength: LIMITS.contactRole,
      })
      break
    case 'website':
      field = textField('website', {
        autoComplete: 'url',
        maxLength: LIMITS.website,
        inputMode: 'url',
      })
      break
    case 'sector':
      field = (
        <OptionList
          items={SECTOR_KEYS.map((k) => ({ value: k, label: f(`sectorOption.${k}`) }))}
          selected={(v) => answers.sector === v}
          onPick={(v) => set('sector', v)}
          labelledBy={titleId}
          describedBy={described}
          columns
        />
      )
      break
    case 'description':
      field = (
        <Textarea
          data-autofocus
          id="cob-description"
          value={answers.description}
          onChange={(e) => set('description', e.target.value)}
          rows={4}
          maxLength={LIMITS.description + 50}
          placeholder={to('placeholder')}
          aria-labelledby={titleId}
          aria-describedby={described || undefined}
          aria-invalid={error ? true : undefined}
          className={cn(UNDERLINE, 'min-h-28 resize-none text-[1.25rem] sm:text-[1.4rem]')}
        />
      )
      break
    case 'logo':
      field = (
        <LogoField
          className="max-w-[560px]"
          logo={answers.logo}
          name={answers.name}
          onChange={changeLogo}
          busy={logoBusy}
        />
      )
      break
  }

  return (
    <OnboardingFrame
      label={t('label')}
      progress={progress}
      count={number > 0 ? to('count', { n: number, total }) : step === 'done' ? to('done') : ''}
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
          <h1 className={BIG_TITLE}>{to('welcomeTitle')}</h1>
          <p className={HELP}>{t('welcomeBody', { total })}</p>
          <div className="flex flex-wrap items-center gap-3.5">
            <Button size="lg" onClick={next}>
              {to('start')}
            </Button>
            <EnterHint />
          </div>
        </>
      )}

      {step === 'done' && <Summary answers={answers} />}

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
                <Link href="/company" className="ml-1 text-primary">
                  {t('toStatus')}
                </Link>
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3.5">
            <Button size="lg" onClick={next} disabled={pending || logoBusy}>
              {pending ? (
                <>
                  <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
                  {to('saving')}
                </>
              ) : (
                <>
                  {step === 'logo' ? to('finish') : to('ok')}
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

function Summary({ answers }: { answers: Answers }) {
  const t = useTranslations('CompanyOnboarding')
  const f = useTranslations('CompanyFields')
  const tl = useTranslations('Logo')
  const none = t('notAnswered')
  const website = normalizeWebsite(answers.website)
  const rows: [string, string][] = [
    [f('name'), answers.name.trim()],
    [f('orgNumber'), formatOrgNumber(normalizeOrgNumber(answers.orgNumber))],
    [f('contactName'), answers.contactName.trim()],
    [f('contactRole'), answers.contactRole.trim()],
    [f('website'), website ?? none],
    [f('sector'), answers.sector ? f(`sectorOption.${answers.sector}`) : none],
    [f('description'), answers.description.trim()],
  ]
  return (
    <>
      <div className="grid gap-4 sm:flex sm:items-center">
        <CompanyAvatar name={answers.name} logoUrl={answers.logo?.url} size="lg" />
        <h1 className={BIG_TITLE}>{t('doneTitle', { name: answers.name.trim() })}</h1>
      </div>
      <p className={HELP}>{t('doneBody')}</p>
      <dl className="grid max-w-[560px] grid-cols-1 gap-x-[18px] gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground max-sm:mt-2">{label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground max-sm:mt-2">{f('logo')}</dt>
        <dd className="font-medium [overflow-wrap:anywhere]">
          {answers.logo ? answers.logo.name : tl('none')}
        </dd>
      </dl>
      <div className="flex flex-wrap gap-3">
        <Button asChild size="lg">
          <Link href="/company">{t('toStatus')}</Link>
        </Button>
        <Button asChild size="lg" variant="secondary">
          <Link href="/company/profile">{t('toProfile')}</Link>
        </Button>
      </div>
      <p className="text-[0.85rem] text-muted-foreground">{t('doneHint')}</p>
    </>
  )
}
