import type { AccountUser } from '@/components/app/AccountMenu'
import type { User } from '@/payload-types'

/**
 * What the account menu shows: the person's name (from the onboarding, or Google for the team),
 * with the email under it. Without a name yet, the email, with `fallbackDetail` under it.
 */
export function accountMenuUser(
  user: Pick<User, 'name' | 'email'>,
  fallbackDetail?: string,
): AccountUser {
  const name = user.name?.trim()
  return name ? { name, detail: user.email } : { name: user.email, detail: fallbackDetail }
}
