'use client'

import { CheckIcon, EyeIcon, EyeOffIcon, LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ComponentProps, type ReactNode, type Ref, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PASSWORD_MAX, PASSWORD_MIN } from '@/lib/auth/passwordRules'
import type { AuthError, FieldErrors } from '@/lib/auth/emailSignIn'
import { cn } from '@/lib/utils'

import { Banner } from './Banner'

/**
 * The pieces every sign-in form uses: fields with their errors tied to them (aria-invalid and
 * aria-describedby), the password field with show/hide and the length rule, the Google button,
 * the "or" line, banners and the result panel. All text comes from the EN/NO message files.
 */

/** The message for a field error, or undefined. */
export function useFieldError() {
  const t = useTranslations('AuthErrors')
  return (fields: FieldErrors | undefined, field: keyof FieldErrors): string | undefined => {
    const code = fields?.[field]
    if (!code) return undefined
    switch (code) {
      case 'invalid':
        return t('emailInvalid')
      case 'required':
        return t('passwordRequired')
      case 'too_short':
        return t('tooShort', { min: PASSWORD_MIN })
      case 'too_long':
        return t('tooLong', { max: PASSWORD_MAX })
      case 'breached':
        return t('breached')
    }
  }
}

/** A banner for a form-level error. Never says whether an account exists. */
export function ErrorBanner({ error }: { error?: AuthError }) {
  const t = useTranslations('AuthErrors')
  if (!error || error === 'invalid_link') return null
  const content: Record<Exclude<AuthError, 'invalid_link'>, { title: string; body?: string }> = {
    invalid_credentials: { title: t('signInFailed'), body: t('signInFailedHint') },
    locked: { title: t('lockedTitle'), body: t('locked') },
    unverified: { title: t('unverifiedTitle'), body: t('unverified') },
    paused: { title: t('pausedTitle'), body: t('paused') },
    too_many: { title: t('tooMany') },
    generic: { title: t('generic') },
  }
  const { title, body } = content[error]
  return (
    <Banner tone={error === 'unverified' ? 'warn' : 'bad'} role="alert">
      <p className="font-semibold">{title}</p>
      {body && <p className="text-[0.88rem] text-muted-foreground">{body}</p>}
    </Banner>
  )
}

type FieldProps = Omit<ComponentProps<typeof Input>, 'id' | 'name'> & {
  id: string
  name: string
  label: string
  error?: string
  hint?: ReactNode
  ref?: Ref<HTMLInputElement>
}

export function TextField({ id, label, error, hint, className, ...input }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint && (
        <div id={`${id}-hint`} className="text-[0.82rem] text-muted-foreground">
          {hint}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[0.88rem] font-semibold text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export function EmailField(props: Omit<FieldProps, 'type' | 'label'> & { label?: string }) {
  const t = useTranslations('Entry')
  return (
    <TextField
      type="email"
      inputMode="email"
      autoComplete="username"
      autoCapitalize="none"
      spellCheck={false}
      placeholder={t('emailPlaceholder')}
      label={props.label ?? t('email')}
      {...props}
    />
  )
}

/**
 * Password with a show/hide button. Paste and password managers work (no blocking, no length
 * cap in the browser: the server answers "too long" past 256). With `rules`, shows the length
 * rule as it is typed and that the breach check runs on save.
 */
export function PasswordField({
  id,
  label,
  error,
  rules = false,
  className,
  ...input
}: Omit<FieldProps, 'type' | 'hint'> & { rules?: boolean }) {
  const t = useTranslations('Entry')
  const [visible, setVisible] = useState(false)
  // Kept here (not left to the browser) so the length rule always matches what is in the field,
  // also after React resets the form when an action returns.
  const [value, setValue] = useState('')
  const length = [...value].length
  const long = length >= PASSWORD_MIN
  const describedBy = [rules && `${id}-rules`, error && `${id}-error`].filter(Boolean).join(' ')

  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className="pr-12"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          {...input}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-controls={id}
          aria-label={visible ? t('hidePassword') : t('showPassword')}
          className="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center rounded-r-item text-muted-foreground hover:text-foreground"
        >
          {visible ? (
            <EyeOffIcon aria-hidden="true" className="size-5" />
          ) : (
            <EyeIcon aria-hidden="true" className="size-5" />
          )}
        </button>
      </div>
      {rules && (
        <ul id={`${id}-rules`} className="grid gap-1.5 text-[0.88rem]">
          <li
            className={cn(
              'flex items-start gap-2',
              long ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <CheckIcon
              aria-hidden="true"
              className={cn('mt-0.5 size-4 shrink-0', long ? 'text-success' : 'opacity-40')}
            />
            <span>
              {t('ruleLength', { min: PASSWORD_MIN, count: Math.min(length, PASSWORD_MIN) })}
            </span>
          </li>
          <li className="flex items-start gap-2 text-muted-foreground">
            <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{t('ruleBreach')}</span>
          </li>
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[0.88rem] font-semibold text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** A full-width submit button that shows it is working while the action runs. */
export function SubmitButton({
  pending,
  children,
  ...props
}: ComponentProps<typeof Button> & { pending: boolean }) {
  return (
    <Button
      type="submit"
      className="w-full"
      disabled={pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending && <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />}
      {children}
    </Button>
  )
}

/** Continue with Google: a normal navigation to the start route, which redirects to Google. */
export function GoogleButton({ label }: { label: string }) {
  return (
    <Button asChild variant="secondary" className="w-full">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- API route, needs a full navigation */}
      <a href="/api/auth/google/start">
        <span
          aria-hidden="true"
          className="grid size-[22px] place-items-center rounded-full border border-edge text-[0.78rem] font-bold"
        >
          G
        </span>
        {label}
      </a>
    </Button>
  )
}

export function OrDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[0.85rem] text-muted-foreground before:flex-1 before:border-t before:border-line after:flex-1 after:border-t after:border-line">
      {children}
    </div>
  )
}

/** The result of a step: "Check your email", "Password changed", "This link has expired". */
export function StatusPanel({
  icon,
  title,
  children,
  actions,
  titleRef,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
  actions?: ReactNode
  titleRef?: Ref<HTMLHeadingElement>
}) {
  return (
    <div className="grid gap-4">
      <span
        aria-hidden="true"
        className="grid size-[52px] place-items-center rounded-full bg-tint text-tint-foreground [&_svg]:size-6"
      >
        {icon}
      </span>
      <h2
        ref={titleRef}
        tabIndex={-1}
        className="text-[1.15rem] leading-tight font-semibold outline-none"
      >
        {title}
      </h2>
      {children && (
        <div className="grid gap-2 [overflow-wrap:anywhere] text-muted-foreground">{children}</div>
      )}
      {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
    </div>
  )
}
