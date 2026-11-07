import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload, type Payload } from 'payload'

import type { AccountUser } from '@/components/app/AccountMenu'
import { isStudent } from '@/access/roles'
import { redirect } from '@/i18n/navigation'
import { accountMenuUser } from '@/lib/account'

import { findOwnProfile, type SessionUser } from './profile'

/**
 * For the student pages: the signed-in student, read with access control on. Anyone else (a
 * company, the team, a signed-out visitor) goes to the entry page, which sends them to their own
 * home; a student without a profile goes to the onboarding first. Data functions and Server
 * Actions check the user again on their own.
 */
export async function requireStudent(
  locale: string,
): Promise<{ payload: Payload; user: SessionUser; account: AccountUser }> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || !isStudent(user)) return redirect({ href: '/', locale })
  const profile = await findOwnProfile(payload, user as SessionUser)
  if (!profile) return redirect({ href: '/student/welcome', locale })
  return {
    payload,
    user: user as SessionUser,
    account: accountMenuUser({ name: user.name || profile.name, email: user.email }),
  }
}
