'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { DeliverableState } from '@/lib/deliverables/fields'

import type { SessionUser } from './approvals'
import { releaseDeliverable, returnDeliverable } from './deliverables'

/**
 * Server Actions for the team's Deliverables screen. Each is a public POST endpoint, so each reads
 * the session again here; the Deliverables hook holds the rules. The acting user never comes from
 * the form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function releaseAction(
  _prev: DeliverableState,
  form: FormData,
): Promise<DeliverableState> {
  const { payload, user } = await session()
  return releaseDeliverable(payload, user, form)
}

export async function returnAction(
  _prev: DeliverableState,
  form: FormData,
): Promise<DeliverableState> {
  const { payload, user } = await session()
  return returnDeliverable(payload, user, form)
}
