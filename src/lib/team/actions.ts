'use server'

import config from '@payload-config'
import { hasLocale } from 'next-intl'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { routing } from '@/i18n/routing'

import {
  dismissMethodNotice,
  fixRole,
  pauseAccount,
  reactivateAccount,
  type SessionUser,
  signOutEverywhere,
} from './accounts'
import type { AccountActionState } from './fields'

/**
 * Server Actions for the team's "User account" screen and the person's own sign-in notice. Each
 * is a public POST endpoint, so each reads the session again here and passes that user on; the
 * rules live in accounts.ts and in the Users collection. The acting user never comes from the
 * form. Next.js refuses Server Action calls whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function fixRoleAction(
  _prev: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const { payload, user } = await session()
  return fixRole(payload, user, form)
}

export async function pauseAccountAction(
  _prev: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const { payload, user } = await session()
  return pauseAccount(payload, user, form)
}

export async function reactivateAccountAction(
  _prev: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const { payload, user } = await session()
  return reactivateAccount(payload, user, form)
}

export async function signOutEverywhereAction(
  _prev: AccountActionState,
  form: FormData,
): Promise<AccountActionState> {
  const { payload, user } = await session()
  return signOutEverywhere(payload, user, form)
}

/** "Continue to Konnected" on the sign-in notice: close it, then go home. */
export async function dismissMethodNoticeAction(form: FormData): Promise<never> {
  const { payload, user } = await session()
  const value = form.get('locale')
  const locale = typeof value === 'string' && hasLocale(routing.locales, value) ? value : 'en'
  await dismissMethodNotice(payload, user)
  redirect(`/${locale}`)
}
