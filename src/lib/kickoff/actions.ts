'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/team/approvals'

import type { KickoffState } from './fields'
import { recordKickoff, saveNoteToCompany, startWork } from './team'

/**
 * Server Actions for the team's project page: the kick-off, starting the work, and the latest note
 * to the company. Each is a public POST endpoint, so each reads the session again here; the
 * decisions check the team member, and the collection hooks hold the rules. The acting user never
 * comes from the form. Form values are never logged.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

type Action = (prev: KickoffState, form: FormData) => Promise<KickoffState>

export const recordKickoffAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return recordKickoff(payload, user, form)
}

export const startWorkAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return startWork(payload, user, form)
}

export const saveNoteAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return saveNoteToCompany(payload, user, form)
}
