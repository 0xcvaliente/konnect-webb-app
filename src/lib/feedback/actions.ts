'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/students/profile'

import { sendFeedback } from './feedback'
import type { FeedbackState } from './fields'

/**
 * The feedback form's Server Action. A public POST endpoint, so it reads the session again here;
 * the Feedback access rules and hook decide who may send it, for which project, and only once.
 */
export async function sendFeedbackAction(
  _prev: FeedbackState,
  form: FormData,
): Promise<FeedbackState> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return sendFeedback(payload, (user as SessionUser | null) ?? null, form)
}
