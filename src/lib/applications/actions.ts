'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/students/profile'

import type { ApplyState, WithdrawState } from './fields'
import { applyToProject, withdrawApplication } from './student'

/**
 * Server Actions for applying and withdrawing. Each is a public POST endpoint, so each reads the
 * session again here and passes that user on; the rules live in student.ts and in the
 * Applications collection's access and hook. The student never comes from the form. Next.js
 * refuses Server Action calls whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function applyAction(_prev: ApplyState, form: FormData): Promise<ApplyState> {
  const { payload, user } = await session()
  return applyToProject(payload, user, form)
}

export async function withdrawAction(_prev: WithdrawState, form: FormData): Promise<WithdrawState> {
  const { payload, user } = await session()
  return withdrawApplication(payload, user, form)
}
