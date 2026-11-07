'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { SessionUser } from '@/lib/students/profile'

import type { ProblemState } from './fields'
import { reportProblem } from './student'

/**
 * The student's Server Action for a problem report. A public POST endpoint, so it reads the
 * session again here; the ProblemReports access rules and hook hold every rule. The student never
 * comes from the form.
 */
export async function reportProblemAction(
  _prev: ProblemState,
  form: FormData,
): Promise<ProblemState> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return reportProblem(payload, (user as SessionUser | null) ?? null, form)
}
