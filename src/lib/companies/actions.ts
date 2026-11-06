'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { registerCompany, saveCompany, type SessionUser } from './company'
import type { CompanyFormState } from './fields'

/**
 * Server Actions for the company onboarding and profile page. Each one is a public POST
 * endpoint, so each reads the session again here and passes that user on; the rules live in
 * company.ts and in the collection's access functions. The user never comes from the form.
 * Next.js refuses Server Action calls whose Origin does not match the host.
 */

async function session() {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return { payload, user: (user as SessionUser | null) ?? null }
}

export async function registerCompanyAction(
  _prev: CompanyFormState,
  form: FormData,
): Promise<CompanyFormState> {
  const { payload, user } = await session()
  return registerCompany(payload, user, form)
}

export async function saveCompanyAction(
  _prev: CompanyFormState,
  form: FormData,
): Promise<CompanyFormState> {
  const { payload, user } = await session()
  return saveCompany(payload, user, form)
}
