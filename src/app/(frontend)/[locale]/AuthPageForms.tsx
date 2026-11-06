'use client'

import { CircleCheckIcon, ClockIcon, MailIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useActionState, useRef, useState } from 'react'

import {
  EmailField,
  ErrorBanner,
  PasswordField,
  StatusPanel,
  SubmitButton,
  useFieldError,
} from '@/components/app/AuthForm'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import {
  confirmEmailAction,
  consumeLinkAction,
  type FormState,
  requestResetAction,
  resetPasswordAction,
} from '@/lib/auth/actions'

import { useFocusFirstError, useFocusOnShow } from './EntryForms'

const IDLE: FormState = { status: 'idle' }

const BackToSignIn = ({ label }: { label: string }) => (
  <Button asChild variant="text">
    <Link href="/">{label}</Link>
  </Button>
)

/** "This link has expired": shared by sign-in, confirmation and reset links. */
export function ExpiredLink({
  title,
  body,
  newLink,
  newLinkHref,
  back,
}: {
  title: string
  body: string
  newLink?: string
  newLinkHref?: string
  back: string
}) {
  const titleRef = useFocusOnShow<HTMLHeadingElement>(true)
  return (
    <Card>
      <StatusPanel
        icon={<ClockIcon />}
        title={title}
        titleRef={titleRef}
        actions={
          <>
            {newLink && newLinkHref && (
              <Button asChild>
                <Link href={newLinkHref}>{newLink}</Link>
              </Button>
            )}
            <BackToSignIn label={back} />
          </>
        }
      >
        <p>{body}</p>
      </StatusPanel>
    </Card>
  )
}

/** Sign-in link landing: one button that POSTs (mail scanners open links but do not press). */
export function MagicLinkForm({ token, locale }: { token: string; locale: string }) {
  const t = useTranslations('MagicLink')
  const [state, action, pending] = useActionState(consumeLinkAction, IDLE)
  if (state.error === 'invalid_link') {
    return (
      <ExpiredLink
        title={t('expiredTitle')}
        body={t('expiredLede')}
        newLink={t('newLink')}
        newLinkHref="/"
        back={t('back')}
      />
    )
  }
  return (
    <Card>
      <form action={action} className="grid gap-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="token" value={token} />
        <ErrorBanner error={state.error} />
        <SubmitButton pending={pending} size="lg">
          {t('button')}
        </SubmitButton>
      </form>
    </Card>
  )
}

/** Email confirmation landing: one button that POSTs, then "Email confirmed". */
export function VerifyEmailForm({ token, locale }: { token: string; locale: string }) {
  const t = useTranslations('Verify')
  const [state, action, pending] = useActionState(confirmEmailAction, IDLE)
  const titleRef = useFocusOnShow<HTMLHeadingElement>(state.status === 'done')
  if (state.error === 'invalid_link') {
    return <ExpiredLink title={t('invalidTitle')} body={t('invalidLede')} back={t('goSignIn')} />
  }
  if (state.status === 'done') {
    return (
      <Card>
        <StatusPanel
          icon={<CircleCheckIcon />}
          title={t('doneTitle')}
          titleRef={titleRef}
          actions={
            <Button asChild>
              <Link href="/">{t('goSignIn')}</Link>
            </Button>
          }
        >
          <p>{t('doneLede')}</p>
        </StatusPanel>
      </Card>
    )
  }
  return (
    <Card>
      <form action={action} className="grid gap-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="token" value={token} />
        <ErrorBanner error={state.error} />
        <SubmitButton pending={pending} size="lg">
          {t('button')}
        </SubmitButton>
      </form>
    </Card>
  )
}

/** Ask for a reset link. The answer is the same for every address. */
export function ResetRequestForm({ locale }: { locale: string }) {
  const t = useTranslations('Reset')
  const fieldError = useFieldError()
  const [state, action, pending] = useActionState(requestResetAction, IDLE)
  const [email, setEmail] = useState('')
  const [dismissed, setDismissed] = useState<FormState | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  useFocusFirstError(state, { email: emailRef })
  const sent = state.status === 'done' && state !== dismissed
  const titleRef = useFocusOnShow<HTMLHeadingElement>(sent)

  if (sent) {
    return (
      <Card>
        <StatusPanel
          icon={<MailIcon />}
          title={t('sentTitle')}
          titleRef={titleRef}
          actions={
            <>
              <Button variant="secondary" type="button" onClick={() => setDismissed(state)}>
                {t('otherEmail')}
              </Button>
              <BackToSignIn label={t('back')} />
            </>
          }
        >
          <p>
            {t.rich('sentLede', {
              email: state.email ?? '',
              b: (c) => <b className="text-foreground">{c}</b>,
            })}
          </p>
          <p className="text-[0.88rem]">{t('sentNote')}</p>
        </StatusPanel>
      </Card>
    )
  }

  return (
    <Card>
      <form action={action} noValidate className="grid gap-3.5">
        <input type="hidden" name="locale" value={locale} />
        <ErrorBanner error={state.error} />
        <EmailField
          id="reset-email"
          name="email"
          ref={emailRef}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldError(state.fields, 'email')}
        />
        <SubmitButton pending={pending}>{t('send')}</SubmitButton>
        <Button asChild variant="text" className="w-full">
          <Link href="/">{t('back')}</Link>
        </Button>
      </form>
    </Card>
  )
}

/** Choose a new password with a reset link. */
export function NewPasswordForm({
  token,
  locale,
  email,
}: {
  token: string
  locale: string
  email: string
}) {
  const t = useTranslations('Reset')
  const fieldError = useFieldError()
  const [state, action, pending] = useActionState(resetPasswordAction, IDLE)
  const passwordRef = useRef<HTMLInputElement>(null)
  useFocusFirstError(state, { password: passwordRef })
  const titleRef = useFocusOnShow<HTMLHeadingElement>(state.status === 'done')

  if (state.error === 'invalid_link') {
    return (
      <ExpiredLink
        title={t('invalidTitle')}
        body={t('invalidLede')}
        newLink={t('newLink')}
        newLinkHref="/reset-password"
        back={t('back')}
      />
    )
  }
  if (state.status === 'done') {
    return (
      <Card>
        <StatusPanel
          icon={<CircleCheckIcon />}
          title={t('doneTitle')}
          titleRef={titleRef}
          actions={
            <Button asChild>
              <Link href="/">{t('goSignIn')}</Link>
            </Button>
          }
        >
          <p>{t('doneLede')}</p>
        </StatusPanel>
      </Card>
    )
  }
  return (
    <Card>
      <form action={action} noValidate className="grid gap-3.5">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="token" value={token} />
        {/* For password managers: which account the new password belongs to. Not sent. */}
        <input
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
        <ErrorBanner error={state.error} />
        <PasswordField
          id="new-password"
          name="password"
          label={t('newPassword')}
          autoComplete="new-password"
          rules
          ref={passwordRef}
          error={fieldError(state.fields, 'password')}
        />
        <SubmitButton pending={pending}>{t('save')}</SubmitButton>
      </form>
    </Card>
  )
}
