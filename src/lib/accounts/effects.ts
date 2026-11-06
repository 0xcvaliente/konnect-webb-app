import type { PayloadRequest } from 'payload'

import { relationId } from '@/access/roles'
import { writeActivity } from '@/hooks/logActivity'
import { appUrl } from '@/lib/auth/env'
import { revokeAllSessions } from '@/lib/auth/session'
import { sendSignInEmail } from '@/lib/email/send'
import {
  accountPausedEmail,
  accountReactivatedEmail,
  emailLocale,
  methodAddedEmail,
  roleChangedEmail,
  type SignInMethod,
} from '@/lib/email/templates'
import type { User } from '@/payload-types'

/**
 * What follows a change to an account, run from the Users hooks so every way in (the team
 * screen, REST, GraphQL, the admin panel, the sign-in code) gets the same result. Emails go only
 * to the account's own address and say what happened, with no reason or other personal data.
 * Nothing here logs an address.
 */

type AccountUser = Pick<User, 'id' | 'email' | 'language'>

const home = (user: AccountUser) => `${appUrl()}/${emailLocale(user.language)}`

/**
 * A new way to sign in was linked to the account: Google, or a password the person chose. The
 * owner of the address gets an email (so someone who added it without them learns about it), and
 * the next page after sign-in shows a notice (Users `methodAddedNotice`).
 */
export async function announceMethodAdded(
  req: PayloadRequest,
  user: AccountUser,
  method: SignInMethod,
): Promise<void> {
  await writeActivity(req, {
    // The person who signed in added it, even when nobody is signed in on this request yet.
    actor: relationId(req.user?.id) ?? user.id,
    action: 'sign_in_method_added',
    targetCollection: 'users',
    targetId: String(user.id),
    toStatus: method,
  })
  await sendSignInEmail(req.payload, {
    to: user.email,
    email: methodAddedEmail(emailLocale(user.language), method, home(user)),
    type: 'method_added',
    userId: user.id,
  })
}

export async function announcePaused(req: PayloadRequest, user: AccountUser): Promise<void> {
  await sendSignInEmail(req.payload, {
    to: user.email,
    email: accountPausedEmail(emailLocale(user.language)),
    type: 'account_paused',
    userId: user.id,
  })
}

export async function announceReactivated(req: PayloadRequest, user: AccountUser): Promise<void> {
  await sendSignInEmail(req.payload, {
    to: user.email,
    email: accountReactivatedEmail(emailLocale(user.language), home(user)),
    type: 'account_reactivated',
    userId: user.id,
  })
}

export async function announceRoleChanged(
  req: PayloadRequest,
  user: AccountUser,
  role: 'student' | 'company',
): Promise<void> {
  await sendSignInEmail(req.payload, {
    to: user.email,
    email: roleChangedEmail(emailLocale(user.language), role, home(user)),
    type: 'role_changed',
    userId: user.id,
  })
}

/** End every session of a user. Their next request is signed out. */
export async function endAllSessions(req: PayloadRequest, userId: number): Promise<void> {
  // Callers have checked that the acting user may do this (the team, or the Users hook on a
  // pause). See revokeAllSessions for why a stale write cannot bring a session back.
  await revokeAllSessions(req.payload, userId, req)
}

/**
 * How much an account has done in its role. The team can fix a wrong role only while this is
 * zero: a student without applications, a company without projects.
 *
 * Bypass: counts with `overrideAccess: true`, because the hook runs for the team member and only
 * the number is used.
 */
export async function workCount(
  req: PayloadRequest,
  user: Pick<User, 'id' | 'role' | 'company'>,
): Promise<number> {
  if (user.role === 'student') {
    const { totalDocs } = await req.payload.count({
      collection: 'applications',
      where: { 'student.user': { equals: user.id } },
      overrideAccess: true,
      req,
    })
    return totalDocs
  }
  if (user.role === 'company') {
    const companyId = relationId(user.company)
    if (!companyId) return 0
    const { totalDocs } = await req.payload.count({
      collection: 'projects',
      where: { company: { equals: companyId } },
      overrideAccess: true,
      req,
    })
    return totalDocs
  }
  return 0
}

/**
 * After a role fix, remove what the person answered for the old role ("The answers they gave as a
 * student are removed", mockup "User account"): the student profile and CVs, or the company and
 * its logos. Only reached when workCount was zero, so nothing else points at these records. Runs
 * in the same transaction as the role change.
 *
 * Bypass: deletes with `overrideAccess: true`. The Users hook has already checked that a team
 * member made a valid role fix; the records belong to the account being fixed.
 */
export async function removeOldRoleData(
  req: PayloadRequest,
  user: Pick<User, 'id' | 'company'>,
  from: 'student' | 'company',
): Promise<void> {
  const { payload } = req
  if (from === 'student') {
    await payload.delete({
      collection: 'student-profiles',
      where: { user: { equals: user.id } },
      overrideAccess: true,
      req,
    })
    await payload.delete({
      collection: 'cvs',
      where: { owner: { equals: user.id } },
      overrideAccess: true,
      req,
    })
    return
  }
  const companyId = relationId(user.company)
  // Unlink first: `users.company` is unique and only the server writes it.
  await payload.db.updateOne({
    collection: 'users',
    where: { id: { equals: user.id } },
    data: { company: null },
    returning: false,
    req,
  })
  if (companyId) {
    await payload.delete({ collection: 'companies', id: companyId, overrideAccess: true, req })
  }
  await payload.delete({
    collection: 'company-logos',
    where: { uploadedBy: { equals: user.id } },
    overrideAccess: true,
    req,
  })
}
