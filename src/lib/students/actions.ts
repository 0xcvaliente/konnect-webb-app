'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { ProfileFormState } from './fields'
import { completeOnboarding, saveProfile, savePrivacy, type SessionUser, setCv } from './profile'

/**
 * Server Actions for the student onboarding and profile page. Each one is a public POST
 * endpoint, so each reads the session again here and passes that user on; the rules live in
 * profile.ts and in the collection's access functions. The user never comes from the form.
 * Next.js refuses Server Action calls whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function completeOnboardingAction(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { payload, user } = await session()
  return completeOnboarding(payload, user, form)
}

export async function saveProfileAction(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { payload, user } = await session()
  return saveProfile(payload, user, form)
}

export async function savePrivacyAction(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { payload, user } = await session()
  return savePrivacy(payload, user, form)
}

export async function setCvAction(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const { payload, user } = await session()
  return setCv(payload, user, form)
}
