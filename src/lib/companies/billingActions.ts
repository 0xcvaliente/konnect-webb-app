'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { saveCompanyBilling, saveOwnBilling } from './billing'
import type { SessionUser } from './company'
import type { BillingFormState } from './fields'

/**
 * Server Actions for the billing details. Each is a public POST endpoint, so each reads the
 * session again here; the Companies access rules and hook decide. The user never comes from the
 * form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

/** The company's own billing details (profile page). */
export async function saveOwnBillingAction(
  _prev: BillingFormState,
  form: FormData,
): Promise<BillingFormState> {
  const { payload, user } = await session()
  return saveOwnBilling(payload, user, form)
}

/** Any company's billing details, by the team (payment log). */
export async function saveCompanyBillingAction(
  _prev: BillingFormState,
  form: FormData,
): Promise<BillingFormState> {
  const { payload, user } = await session()
  return saveCompanyBilling(payload, user, form)
}
