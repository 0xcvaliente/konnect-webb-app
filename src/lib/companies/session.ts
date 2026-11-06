import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { redirect } from '@/i18n/navigation'
import type { Company } from '@/payload-types'

import { findOwnCompany, type SessionUser } from './company'

/**
 * For the company pages: the signed-in company user and their company, read as that user with
 * access control on. Anyone else goes to the entry page; a company user without a company goes
 * to the onboarding. Server Actions check the session again on their own.
 */
export async function requireOwnCompany(
  locale: string,
): Promise<{ user: SessionUser; company: Company }> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || user.role !== 'company') return redirect({ href: '/', locale })
  const company = await findOwnCompany(payload, user as SessionUser, 1)
  if (!company) return redirect({ href: '/company/welcome', locale })
  return { user: user as SessionUser, company }
}
