'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { ProblemState } from '@/lib/problems/fields'

import type { SessionUser } from './approvals'
import {
  askCompanyForChanges,
  closeWithoutDelivery,
  endMatchAndReopen,
  markReportHandled,
  moveDueDate,
  reopenApplications,
} from './projects'

/**
 * Server Actions for the team's project page (problem paths). Each is a public POST endpoint, so
 * each reads the session again here; the decisions check the team member, and the collection
 * hooks hold the rules. The acting user never comes from the form.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

type Action = (prev: ProblemState, form: FormData) => Promise<ProblemState>

export const moveDueDateAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return moveDueDate(payload, user, form)
}

export const endMatchAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return endMatchAndReopen(payload, user, form)
}

export const closeProjectAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return closeWithoutDelivery(payload, user, form)
}

export const reopenAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return reopenApplications(payload, user, form)
}

export const askChangesAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return askCompanyForChanges(payload, user, form)
}

export const handledAction: Action = async (_prev, form) => {
  const { payload, user } = await session()
  return markReportHandled(payload, user, form)
}
