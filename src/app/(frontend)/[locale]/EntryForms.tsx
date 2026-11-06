'use client'

import { MailIcon, ShieldCheckIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  type KeyboardEvent,
  type RefObject,
  useActionState,
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  EmailField,
  ErrorBanner,
  GoogleButton,
  OrDivider,
  PasswordField,
  StatusPanel,
  SubmitButton,
  useFieldError,
} from '@/components/app/AuthForm'
import { Banner } from '@/components/app/Banner'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Link } from '@/i18n/navigation'
import {
  type FormState,
  passwordSignInAction,
  requestLinkAction,
  signUpAction,
} from '@/lib/auth/actions'

const IDLE: FormState = { status: 'idle' }

/** Focus the first field with an error after a failed submit, so its message is read out. */
export function useFocusFirstError(
  state: FormState,
  fields: Record<string, RefObject<HTMLInputElement | null>>,
) {
  useEffect(() => {
    if (state.status !== 'error' || !state.fields) return
    for (const name of Object.keys(fields)) {
      if (state.fields[name as keyof typeof state.fields]) {
        fields[name]?.current?.focus()
        return
      }
    }
  }, [state]) // eslint-disable-line react-hooks/exhaustive-deps -- run once per new result
}

/** Move focus to a result panel's title when it appears. */
export function useFocusOnShow<T extends HTMLElement>(shown: boolean) {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (shown) ref.current?.focus()
  }, [shown])
  return ref
}

/**
 * The entry card ("Final pass" mockup, Sign in): two tabs. Sign in offers Google, an email
 * sign-in link, or a password; Create account offers Google, or an email and a password.
 * Answers never say whether an account exists.
 */
export function EntryForms({
  locale,
  initialTab,
  notice,
  signedOut,
}: {
  locale: string
  initialTab: 'signin' | 'signup'
  /** A message from the Google flow (cancelled, expired), already in the page's language. */
  notice?: string
  /** "You are signed out" after a sign-out; "You were signed out" when a session ended. */
  signedOut?: 'now' | 'ended'
}) {
  const t = useTranslations('Entry')
  return (
    <Card className="gap-4">
      <Tabs defaultValue={initialTab}>
        <TabsList aria-label={t('tabsLabel')} className="mb-1">
          <TabsTrigger value="signin">{t('tabSignIn')}</TabsTrigger>
          <TabsTrigger value="signup">{t('tabSignUp')}</TabsTrigger>
        </TabsList>
        <TabsContent value="signin" className="grid gap-4">
          <SignIn locale={locale} notice={notice} signedOut={signedOut} />
        </TabsContent>
        <TabsContent value="signup" className="grid gap-4">
          <SignUp locale={locale} />
        </TabsContent>
      </Tabs>
    </Card>
  )
}

function SignIn({
  locale,
  notice,
  signedOut,
}: {
  locale: string
  notice?: string
  signedOut?: 'now' | 'ended'
}) {
  const t = useTranslations('Entry')
  const fieldError = useFieldError()
  const [linkState, linkAction, linkPending] = useActionState(requestLinkAction, IDLE)
  const [pwState, pwAction, pwPending] = useActionState(passwordSignInAction, IDLE)
  const [email, setEmail] = useState('')
  const [usePassword, setUsePassword] = useState(false)
  // Which button was used last, so the right answer is shown.
  const [active, setActive] = useState<'link' | 'password'>('link')
  const [dismissed, setDismissed] = useState<FormState | null>(null)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const signInRef = useRef<HTMLButtonElement>(null)
  const state = active === 'link' ? linkState : pwState
  useFocusFirstError(linkState, { email: emailRef })
  useFocusFirstError(pwState, { email: emailRef, password: passwordRef })

  const sent = linkState.status === 'done' && linkState !== dismissed
  const titleRef = useFocusOnShow<HTMLHeadingElement>(sent)

  // Enter in a field signs in with the password once that part is open.
  const enterSignsIn = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !usePassword) return
    event.preventDefault()
    setActive('password')
    event.currentTarget.form?.requestSubmit(signInRef.current)
  }

  if (sent) {
    return (
      <StatusPanel
        icon={<MailIcon />}
        title={t('linkSentTitle')}
        titleRef={titleRef}
        actions={
          <>
            <form action={linkAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="email" value={linkState.email ?? ''} />
              <SubmitButton variant="secondary" pending={linkPending} className="w-auto">
                {t('sendAgain')}
              </SubmitButton>
            </form>
            <Button variant="text" type="button" onClick={() => setDismissed(linkState)}>
              {t('useAnotherEmail')}
            </Button>
          </>
        }
      >
        <p>
          {t.rich('linkSentBody', {
            email: linkState.email ?? '',
            b: (c) => <b className="text-foreground">{c}</b>,
          })}
        </p>
        <p className="text-[0.88rem]">{t('spamHint')}</p>
      </StatusPanel>
    )
  }

  return (
    <>
      {notice && (
        <Banner tone="bad" role="alert">
          {notice}
        </Banner>
      )}
      {signedOut && !notice && (
        <Banner tone={signedOut === 'now' ? 'ok' : 'info'} role="status">
          <p className="font-semibold">
            {signedOut === 'now' ? t('signedOutTitle') : t('sessionEndedTitle')}
          </p>
          <p className="text-[0.88rem] text-muted-foreground">
            {signedOut === 'now' ? t('signedOutBody') : t('sessionEndedBody')}
          </p>
        </Banner>
      )}
      <GoogleButton label={t('continueWithGoogle')} />
      <OrDivider>{t('or')}</OrDivider>
      <form action={linkAction} noValidate className="grid gap-3.5">
        <input type="hidden" name="locale" value={locale} />
        <ErrorBanner error={state.status === 'error' ? state.error : undefined} />
        <EmailField
          id="signin-email"
          name="email"
          ref={emailRef}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={enterSignsIn}
          error={fieldError(state.fields, 'email')}
        />
        <SubmitButton pending={linkPending} onClick={() => setActive('link')}>
          {t('sendLink')}
        </SubmitButton>
        <details
          open={usePassword}
          onToggle={(e) => setUsePassword(e.currentTarget.open)}
          className="group"
        >
          <summary className="flex min-h-11 cursor-pointer items-center rounded-full font-semibold text-primary">
            {t('usePassword')}
          </summary>
          <div className="grid gap-3.5 pt-1.5">
            <PasswordField
              id="signin-password"
              name="password"
              // Not sent with a sign-in link request while this part is closed.
              disabled={!usePassword}
              label={t('password')}
              autoComplete="current-password"
              ref={passwordRef}
              onKeyDown={enterSignsIn}
              error={active === 'password' ? fieldError(pwState.fields, 'password') : undefined}
            />
            <SubmitButton
              ref={signInRef}
              variant="normal"
              formAction={pwAction}
              pending={pwPending}
              onClick={() => setActive('password')}
            >
              {t('signIn')}
            </SubmitButton>
            <Link
              href="/reset-password"
              className="inline-flex min-h-11 items-center justify-self-start font-semibold"
            >
              {t('forgotPassword')}
            </Link>
          </div>
        </details>
      </form>
      <p className="text-[0.85rem] text-muted-foreground">{t('teamGoogle')}</p>
    </>
  )
}

function SignUp({ locale }: { locale: string }) {
  const t = useTranslations('Entry')
  const fieldError = useFieldError()
  const [state, action, pending] = useActionState(signUpAction, IDLE)
  const [email, setEmail] = useState('')
  const [dismissed, setDismissed] = useState<FormState | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  useFocusFirstError(state, { email: emailRef, password: passwordRef })

  const done = state.status === 'done' && state !== dismissed
  const titleRef = useFocusOnShow<HTMLHeadingElement>(done)

  if (done) {
    return (
      <StatusPanel
        icon={<ShieldCheckIcon />}
        title={t('verifySentTitle')}
        titleRef={titleRef}
        actions={
          <Button variant="text" type="button" onClick={() => setDismissed(state)}>
            {t('useAnotherEmail')}
          </Button>
        }
      >
        <p>
          {t.rich('verifySentBody', {
            email: state.email ?? '',
            b: (c) => <b className="text-foreground">{c}</b>,
          })}
        </p>
        <p className="text-[0.88rem]">{t('verifySentNote')}</p>
      </StatusPanel>
    )
  }

  return (
    <>
      <GoogleButton label={t('signUpWithGoogle')} />
      <OrDivider>{t('orEmail')}</OrDivider>
      <form action={action} noValidate className="grid gap-3.5">
        <input type="hidden" name="locale" value={locale} />
        <ErrorBanner error={state.status === 'error' ? state.error : undefined} />
        <EmailField
          id="signup-email"
          name="email"
          autoComplete="email"
          ref={emailRef}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError(state.fields, 'email')}
        />
        <PasswordField
          id="signup-password"
          name="password"
          label={t('password')}
          autoComplete="new-password"
          rules
          ref={passwordRef}
          error={fieldError(state.fields, 'password')}
        />
        <SubmitButton pending={pending}>{t('createAccount')}</SubmitButton>
        <p className="text-[0.85rem] text-muted-foreground">{t('confirmFirst')}</p>
      </form>
    </>
  )
}
