import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import { isAdmin } from '@/access/roles'
import { redirect } from '@/i18n/navigation'

import type { SessionUser } from './accounts'

/**
 * For the team workspace pages: the signed-in Konnected team member. Anyone else goes to the
 * home page, which sends them where they belong. This is a page guard only; the Server Actions
 * and the collection access functions check the user again on their own.
 */
export async function requireTeam(locale: string) {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  if (!user || !isAdmin(user)) return redirect({ href: '/', locale })
  return { payload, user: user as SessionUser }
}
