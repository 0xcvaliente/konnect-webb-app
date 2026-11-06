import { APIError, createLocalReq, type Payload, type Where } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { isAdmin, relationId } from '@/access/roles'
import { writeActivity } from '@/hooks/logActivity'
import { endAllSessions } from '@/lib/accounts/effects'
import type { ActivityLog, User } from '@/payload-types'

import {
  ACCOUNT_FILTERS,
  type AccountActionState,
  type AccountError,
  type AccountFilter,
  PAGE_SIZE,
  REASON_MAX,
} from './fields'

/**
 * The team's account screens ("User account" mockup): find an account, fix a wrong role, pause
 * and reactivate, sign out everywhere. Plain functions over Payload so they can be tested without
 * a request; the Server Actions in actions.ts call them with the signed-in user.
 *
 * Every read and write goes through the Local API as the team member with `overrideAccess:
 * false`, so the Users access rules and hooks decide (transitions, "never admin", "not once there
 * are applications or projects", ending sessions on a pause). The checks here come first only to
 * give clear answers. Nothing here logs names, addresses or the reason.
 */

export type SessionUser = User & { collection: 'users' }

const ok = (): AccountActionState => ({ status: 'done', doneAt: Date.now() })
const fail = (error: AccountError): AccountActionState => ({ status: 'error', error })

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

const idOf = (form: FormData): number | undefined => {
  const id = Number(text(form, 'userId'))
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** A team account: admin role, or an address on the ADMIN_EMAILS list. */
export const isTeamAccount = (user: Pick<User, 'role' | 'email'>): boolean =>
  user.role === 'admin' || isAdminEmail(user.email)

// ---------- Reading ----------

export type AccountListItem = Pick<
  User,
  'id' | 'name' | 'email' | 'role' | 'accountStatus' | 'createdAt'
>

export type AccountList = {
  docs: AccountListItem[]
  totalDocs: number
  page: number
  totalPages: number
}

export const isAccountFilter = (value: unknown): value is AccountFilter =>
  (ACCOUNT_FILTERS as readonly unknown[]).includes(value)

/** Accounts for the team's list: newest first, with a search on name and email and a filter. */
export async function listAccounts(
  payload: Payload,
  actor: SessionUser | null,
  { q = '', filter = 'all', page = 1 }: { q?: string; filter?: AccountFilter; page?: number },
): Promise<AccountList | null> {
  if (!actor || !isAdmin(actor)) return null
  const and: Where[] = []
  const query = q.trim().slice(0, 100)
  if (query) {
    and.push({ or: [{ email: { like: query } }, { name: { like: query } }] })
  }
  if (filter === 'paused') and.push({ accountStatus: { equals: 'paused' } })
  else if (filter !== 'all') and.push({ role: { equals: filter } })

  const result = await payload.find({
    collection: 'users',
    where: and.length ? { and } : {},
    sort: '-createdAt',
    limit: PAGE_SIZE,
    page: Math.max(1, Math.floor(page) || 1),
    depth: 0,
    select: { name: true, email: true, role: true, accountStatus: true, createdAt: true },
    user: actor,
    overrideAccess: false,
  })
  return {
    docs: result.docs as AccountListItem[],
    totalDocs: result.totalDocs,
    page: result.page ?? 1,
    totalPages: Math.max(1, result.totalPages),
  }
}

export type ActivityItem = Pick<
  ActivityLog,
  'id' | 'action' | 'field' | 'fromStatus' | 'toStatus' | 'note' | 'createdAt'
> & { actorName: string | null }

export type AccountView = {
  user: User
  /** Applications (student) or projects (company). The role can be fixed only while it is 0. */
  work: number
  /** A student profile or company record exists (what a role fix would remove). */
  hasRoleData: boolean
  isTeam: boolean
  methods: ('google' | 'link' | 'password')[]
  /** The reason the team gave for the current pause, when the account is paused. */
  pauseReason: string | null
  activity: ActivityItem[]
}

/** Everything the "User account" screen shows, read as the team member. */
export async function loadAccount(
  payload: Payload,
  actor: SessionUser | null,
  id: number,
): Promise<AccountView | null> {
  if (!actor || !isAdmin(actor) || !Number.isInteger(id) || id < 1) return null
  const asActor = { user: actor, overrideAccess: false as const }
  const user = (await payload.findByID({
    collection: 'users',
    id,
    depth: 0,
    disableErrors: true,
    ...asActor,
  })) as User | null
  if (!user) return null

  let work = 0
  let hasRoleData = false
  if (user.role === 'student') {
    work = (
      await payload.count({
        collection: 'applications',
        where: { 'student.user': { equals: user.id } },
        ...asActor,
      })
    ).totalDocs
    hasRoleData =
      (
        await payload.count({
          collection: 'student-profiles',
          where: { user: { equals: user.id } },
          ...asActor,
        })
      ).totalDocs > 0
  } else if (user.role === 'company') {
    const companyId = relationId(user.company)
    hasRoleData = Boolean(companyId)
    if (companyId) {
      work = (
        await payload.count({
          collection: 'projects',
          where: { company: { equals: companyId } },
          ...asActor,
        })
      ).totalDocs
    }
  }

  const logs = await payload.find({
    collection: 'activity-logs',
    where: {
      and: [{ targetCollection: { equals: 'users' } }, { targetId: { equals: String(user.id) } }],
    },
    sort: '-createdAt',
    limit: 50,
    depth: 1,
    ...asActor,
  })
  const activity: ActivityItem[] = logs.docs.map((row) => {
    const actorDoc = typeof row.actor === 'object' && row.actor ? row.actor : null
    return {
      id: row.id,
      action: row.action,
      field: row.field,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      note: row.note,
      createdAt: row.createdAt,
      actorName: actorDoc ? actorDoc.name || actorDoc.email : null,
    }
  })
  const pauseRow = activity.find((row) => row.field === 'accountStatus')
  const isTeam = isTeamAccount(user)

  return {
    user,
    work,
    hasRoleData,
    isTeam,
    methods: [
      ...(user.googleSub ? (['google'] as const) : []),
      // Team accounts sign in with Google only.
      ...(isTeam ? [] : (['link'] as const)),
      ...(user.passwordSetAt && !isTeam ? (['password'] as const) : []),
    ],
    pauseReason:
      user.accountStatus === 'paused' && pauseRow?.toStatus === 'paused'
        ? (pauseRow.note ?? null)
        : null,
    activity,
  }
}

// ---------- Writing ----------

/** Payload's refusals as answers for the page. Never throws: a throwing action loses the page. */
function refused(payload: Payload, error: unknown): AccountActionState {
  const status =
    error instanceof APIError || (typeof error === 'object' && error && 'status' in error)
      ? Number((error as { status: unknown }).status)
      : undefined
  if (status === 409) return fail('has_work')
  if (status === 404) return fail('not_found')
  if (status === 400 || status === 403) return fail('not_allowed')
  payload.logger.error({
    msg: 'Team account change failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/** The account a form is about, read as the team member. */
async function target(payload: Payload, actor: SessionUser, form: FormData) {
  const id = idOf(form)
  if (!id) return null
  return (await payload.findByID({
    collection: 'users',
    id,
    depth: 0,
    disableErrors: true,
    user: actor,
    overrideAccess: false,
  })) as User | null
}

/**
 * Fix a wrong role pick: student to company or company to student. The Users hook refuses
 * everything else (admin, pending, an account with applications or projects) and removes what
 * the person answered for the old role.
 */
export async function fixRole(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<AccountActionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const to = text(form, 'role')
  if (to !== 'student' && to !== 'company') return fail('not_allowed')
  const user = await target(payload, actor, form)
  if (!user) return fail('not_found')
  if (isTeamAccount(user) || user.role === to) return fail('not_allowed')
  try {
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { role: to },
      user: actor,
      overrideAccess: false,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/** Pause an account, with the team's reason. Its sessions end in the Users hook. */
export async function pauseAccount(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<AccountActionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const reason = text(form, 'reason')
  if (!reason) return fail('reason_required')
  if (reason.length > REASON_MAX) return fail('reason_too_long')
  const user = await target(payload, actor, form)
  if (!user) return fail('not_found')
  if (isTeamAccount(user) || user.accountStatus === 'paused') return fail('not_allowed')
  try {
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { accountStatus: 'paused' },
      user: actor,
      overrideAccess: false,
      context: { activityNote: reason },
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

export async function reactivateAccount(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<AccountActionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const user = await target(payload, actor, form)
  if (!user) return fail('not_found')
  if (user.accountStatus !== 'paused') return fail('not_allowed')
  try {
    await payload.update({
      collection: 'users',
      id: user.id,
      data: { accountStatus: 'active' },
      user: actor,
      overrideAccess: false,
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/**
 * End every session of an account ("Sign out everywhere"). The person can sign in again at once;
 * this is for a lost phone or a shared computer, not a ban (that is a pause).
 */
export async function signOutEverywhere(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<AccountActionState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  // Read as the team member first: the session list itself is not part of the API.
  const user = await target(payload, actor, form)
  if (!user) return fail('not_found')
  const req = await createLocalReq({ user: actor }, payload)
  try {
    await endAllSessions(req, user.id)
    await writeActivity(req, {
      action: 'sign_out_everywhere',
      targetCollection: 'users',
      targetId: String(user.id),
    })
  } catch (error) {
    return refused(payload, error)
  }
  return ok()
}

/** The person closes their own "a new way to sign in was added" notice. */
export async function dismissMethodNotice(
  payload: Payload,
  user: SessionUser | null,
): Promise<boolean> {
  if (!user || !user.methodAddedNotice) return false
  await payload.update({
    collection: 'users',
    id: user.id,
    data: { methodAddedNotice: null },
    user,
    overrideAccess: false,
  })
  return true
}
