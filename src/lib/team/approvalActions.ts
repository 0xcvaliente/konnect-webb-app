'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { ReviewState } from './approvalFields'
import {
  approveCompany,
  approveProject,
  askCompanyInfo,
  askProfileChanges,
  markProfileReviewed,
  publishProject,
  rejectCompany,
  rejectProject,
  requestProjectChanges,
  type SessionUser,
} from './approvals'

/**
 * Server Actions for the team's approval queue. Each is a public POST endpoint, so each reads the
 * session again here and passes that user on; the rules live in approvals.ts and in the
 * collections' access functions and hooks. The acting user never comes from the form. Next.js
 * refuses Server Action calls whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

type Run = typeof approveCompany

const action = (run: Run) => async (form: FormData) => {
  const { payload, user } = await session()
  return run(payload, user, form)
}

export async function approveCompanyAction(_prev: ReviewState, form: FormData) {
  return action(approveCompany)(form)
}
export async function rejectCompanyAction(_prev: ReviewState, form: FormData) {
  return action(rejectCompany)(form)
}
export async function askCompanyInfoAction(_prev: ReviewState, form: FormData) {
  return action(askCompanyInfo)(form)
}
export async function approveProjectAction(_prev: ReviewState, form: FormData) {
  return action(approveProject)(form)
}
export async function requestProjectChangesAction(_prev: ReviewState, form: FormData) {
  return action(requestProjectChanges)(form)
}
export async function rejectProjectAction(_prev: ReviewState, form: FormData) {
  return action(rejectProject)(form)
}
export async function publishProjectAction(_prev: ReviewState, form: FormData) {
  return action(publishProject)(form)
}
export async function markProfileReviewedAction(_prev: ReviewState, form: FormData) {
  return action(markProfileReviewed)(form)
}
export async function askProfileChangesAction(_prev: ReviewState, form: FormData) {
  return action(askProfileChanges)(form)
}
