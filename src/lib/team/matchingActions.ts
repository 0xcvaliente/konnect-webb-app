'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { MatchState } from '@/lib/matching/fields'

import type { SessionUser } from './approvals'
import { selectApplication, shortlistApplication } from './matching'

/**
 * Server Actions for the team's Matching screen. Each is a public POST endpoint, so each reads the
 * session again here; the rules live in the Applications hook (lib/matching/rules.ts) and the
 * collections' access functions. The acting user never comes from the form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function shortlistAction(_prev: MatchState, form: FormData): Promise<MatchState> {
  const { payload, user } = await session()
  return shortlistApplication(payload, user, form)
}

export async function selectAction(_prev: MatchState, form: FormData): Promise<MatchState> {
  const { payload, user } = await session()
  return selectApplication(payload, user, form)
}
