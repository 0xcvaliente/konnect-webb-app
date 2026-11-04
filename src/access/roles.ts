import type { Company, User } from '@/payload-types'

export type Role = User['role']

/** The slice of a user that access functions need. `req.user` satisfies it. */
export type AccessUser = Pick<User, 'id' | 'role'> & { company?: User['company'] }

type Maybe<T> = T | null | undefined

export const isAdmin = (user: Maybe<AccessUser>): boolean => user?.role === 'admin'
export const isStudent = (user: Maybe<AccessUser>): boolean => user?.role === 'student'
export const isCompany = (user: Maybe<AccessUser>): boolean => user?.role === 'company'

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
