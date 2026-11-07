'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/students/profile'

import type { DeliverableState } from './fields'
import { companyDecision, submitDeliverable } from './student'

/**
 * Server Actions for the hand-off: the student sends a hand-in; the company accepts the released
 * work or asks for its one round of fixes. Each is a public POST endpoint, so each reads the
 * session again here; the collection's access rules and hook hold every rule. The acting user
 * never comes from the form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function submitDeliverableAction(
  _prev: DeliverableState,
  form: FormData,
): Promise<DeliverableState> {
  const { payload, user } = await session()
  return submitDeliverable(payload, user, form)
}

export async function acceptDeliverableAction(
  _prev: DeliverableState,
  form: FormData,
): Promise<DeliverableState> {
  const { payload, user } = await session()
  return companyDecision(payload, user, form, 'accept')
}

export async function requestFixAction(
  _prev: DeliverableState,
  form: FormData,
): Promise<DeliverableState> {
  const { payload, user } = await session()
  return companyDecision(payload, user, form, 'fix')
}
