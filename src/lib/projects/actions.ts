'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { ProjectFormState, ProjectInput } from './fields'
import { saveProjectDraft, sendProjectForReview, type SessionUser } from './project'

/**
 * Server Actions for the company's project form. Each one is a public POST endpoint, so each
 * reads the session again here and passes that user on; the rules live in project.ts and in the
 * collection's access functions and hooks. The user and the company never come from the form,
 * and the input is read again from scratch on the server. Next.js refuses Server Action calls
 * whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function saveProjectDraftAction(
  id: number | undefined,
  input: ProjectInput,
): Promise<ProjectFormState> {
  const { payload, user } = await session()
  return saveProjectDraft(payload, user, id, input)
}

export async function sendProjectForReviewAction(
  id: number | undefined,
  input: ProjectInput,
): Promise<ProjectFormState> {
  const { payload, user } = await session()
  return sendProjectForReview(payload, user, id, input)
}
