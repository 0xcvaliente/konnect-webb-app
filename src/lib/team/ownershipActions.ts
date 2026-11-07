'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from './approvals'
import type { TeamFormState } from './memberFields'
import { saveAway } from './members'
import { reassign, takeFromPool } from './ownership'

/**
 * Server Actions for the team workspace (Today, the Team page, a project's owner). Each is a
 * public POST endpoint, so each reads the session again here; the functions check that the user
 * is on the team, and the collection hooks hold the rules. The acting user never comes from the
 * form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

type Action = (prev: TeamFormState, form: FormData) => Promise<TeamFormState>

export const takeAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return takeFromPool(payload, user, form)
}

export const reassignAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return reassign(payload, user, form)
}

export const awayAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return saveAway(payload, user, form)
}
