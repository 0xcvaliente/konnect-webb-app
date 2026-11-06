'use server'

import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { type Locale, routing } from '@/i18n/routing'

import {
  type AuthError,
  confirmEmail,
  consumeMagicLink,
  type FieldErrors,
  requestMagicLink,
  requestPasswordReset,
  resetPasswordWithToken,
  signInWithPassword,
  type SignedIn,
  signUpWithPassword,
} from './emailSignIn'
import { clientIp } from './rateLimit'

/**
 * Server Actions for the sign-in pages. Each one is a public POST endpoint, so each re-checks its
 * input on the server and does nothing a signed-out visitor may not do. The rules live in
 * emailSignIn.ts. Next.js refuses Server Action calls whose Origin does not match the host.
 *
 * Nothing here is logged. The email address goes back to the page only to show it to the person
 * who typed it.
 */
export type FormState = {
  status: 'idle' | 'done' | 'error'
  email?: string
  error?: AuthError
  fields?: FieldErrors
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

const localeOf = (form: FormData): Locale => {
  const value = text(form, 'locale')
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale
}

const context = async (form: FormData) => ({
  payload: await getPayload({ config }),
  locale: localeOf(form),
  ip: clientIp(await headers()),
})

const toState = (
  result: { ok: true } | { ok: false; error?: AuthError; fields?: FieldErrors },
  email?: string,
): FormState =>
  result.ok
    ? { status: 'done', email }
    : { status: 'error', email, error: result.error, fields: result.fields }

/** Set the Payload session cookie, then go to the role step or home. */
async function finishSignIn(result: SignedIn, locale: Locale): Promise<never> {
  const { name, value, ...options } = result.cookie
  ;(await cookies()).set(name, value, options)
  redirect(`/${locale}${result.user.role === 'pending' ? '/choose-role' : ''}`)
}

export async function requestLinkAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, locale, ip } = await context(form)
  const email = text(form, 'email').trim()
  return toState(await requestMagicLink(payload, { email, locale, ip }), email)
}

export async function passwordSignInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, locale, ip } = await context(form)
  const email = text(form, 'email').trim()
  const result = await signInWithPassword(payload, {
    email,
    password: form.get('password'),
    locale,
    ip,
  })
  if (result.ok) return finishSignIn(result, locale)
  return toState(result, email)
}

export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, locale, ip } = await context(form)
  const email = text(form, 'email').trim()
  const result = await signUpWithPassword(payload, {
    email,
    password: form.get('password'),
    locale,
    ip,
  })
  return toState(result, email)
}

export async function consumeLinkAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, locale, ip } = await context(form)
  const result = await consumeMagicLink(payload, { token: text(form, 'token'), locale, ip })
  if (result.ok) return finishSignIn(result, locale)
  return toState(result)
}

export async function confirmEmailAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, ip } = await context(form)
  return toState(await confirmEmail(payload, { token: text(form, 'token'), ip }))
}

export async function requestResetAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, locale, ip } = await context(form)
  const email = text(form, 'email').trim()
  return toState(await requestPasswordReset(payload, { email, locale, ip }), email)
}

export async function resetPasswordAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { payload, ip } = await context(form)
  return toState(
    await resetPasswordWithToken(payload, {
      token: text(form, 'token'),
      password: form.get('password'),
      ip,
    }),
  )
}
