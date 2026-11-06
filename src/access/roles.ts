import type { Company, User } from '@/payload-types'

import { isAdminEmail } from './adminEmails'

export type Role = User['role']

/**
 * The slice of a user that access functions need. `req.user` satisfies it. `email` and
 * `accountStatus` are optional in the type so plain `{ id, role }` objects still compile, but a
 * user without them is treated as fail-closed (see isAdmin and isActive).
 */
export type AccessUser = Pick<User, 'id' | 'role'> & {
  company?: User['company']
  email?: string | null
  accountStatus?: User['accountStatus'] | null
}

type Maybe<T> = T | null | undefined

/**
 * A paused account can do nothing (owner decision for the "User account" card). Its sessions are
 * ended when it is paused and it cannot sign in again (Users `beforeLogin`, createSessionToken);
 * this check is the second layer, in every access function that goes through the helpers below.
 */
export const isActive = (user: Maybe<AccessUser>): boolean =>
  Boolean(user) && user!.accountStatus !== 'paused'

/**
 * Admin only for an active user whose role is `admin` AND whose address is still on the
 * ADMIN_EMAILS list. Removing an address from the list takes admin access away at once, even
 * from a session that is already open. A user object without an email is never admin.
 */
export const isAdmin = (user: Maybe<AccessUser>): boolean =>
  user?.role === 'admin' && isActive(user) && isAdminEmail(user.email)
export const isStudent = (user: Maybe<AccessUser>): boolean =>
  user?.role === 'student' && isActive(user)
export const isCompany = (user: Maybe<AccessUser>): boolean =>
  user?.role === 'company' && isActive(user)

/** The role access checks should use: the stored role, or none when it does not count. */
export const effectiveRole = (user: Maybe<AccessUser>): Role | undefined => {
  if (!user || !isActive(user)) return undefined
  if (user.role === 'admin') return isAdmin(user) ? 'admin' : undefined
  return user.role
}

/** A relationship value is either an id or a populated document. Return the id. */
export const relationId = (value: Maybe<number | { id: number }>): number | undefined =>
  typeof value === 'object' && value !== null ? value.id : (value ?? undefined)

/** The company a company-role user belongs to, or undefined. */
export const companyIdOf = (user: Maybe<AccessUser>): number | undefined =>
  isCompany(user) ? relationId(user?.company as Maybe<number | Company>) : undefined

/** Field-level access helpers. Field access returns a boolean only, never a Where. */
export const adminOnlyField = ({ req: { user } }: { req: { user?: Maybe<AccessUser> } }) =>
  isAdmin(user)

export const adminOrStudentField = ({ req: { user } }: { req: { user?: Maybe<AccessUser> } }) =>
  isAdmin(user) || isStudent(user)

export const adminOrCompanyField = ({ req: { user } }: { req: { user?: Maybe<AccessUser> } }) =>
  isAdmin(user) || isCompany(user)
