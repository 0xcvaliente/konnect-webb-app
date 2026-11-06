import type { PayloadRequest, Where } from 'payload'
import { APIError, AuthenticationError, type CollectionConfig } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { adminOnlyField, effectiveRole, isAdmin, type Role } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  announceMethodAdded,
  announcePaused,
  announceReactivated,
  announceRoleChanged,
  endAllSessions,
  removeOldRoleData,
  workCount,
} from '@/lib/accounts/effects'
import { dummyPasswordHash, type PasswordContext, validatePassword } from '@/lib/auth/password'
import { AccountPausedError, isPaused } from '@/lib/auth/paused'
import { confirmEmailToken } from '@/lib/auth/verification'
import type { SignInMethod } from '@/lib/email/templates'
import {
  ACCOUNT_TRANSITIONS,
  type AccountStatus,
  assertInitialStatus,
  assertTransition,
  ROLE_TRANSITIONS,
} from '@/lib/transitions'
import type { User } from '@/payload-types'
import {
  resetEmailHTML,
  resetEmailSubject,
  verifyEmailHTML,
  verifyEmailSubject,
} from '@/lib/email/authEmails'

const selfOrAdmin = ({ req: { user }, id }: { req: PayloadRequest; id?: number | string }) =>
  isAdmin(user) || (user != null && user.id === id)

/** What the hooks pass on to the afterChange and afterOperation steps of the same request. */
type AccountContext = PasswordContext & {
  passwordReset?: boolean
  /** A sign-in method linked by this change (set in beforeChange or beforeValidate). */
  methodAdded?: SignInMethod
}

export const NAME_MAX = 120

/** Record the time of a sign-in. Never fails the sign-in itself. */
async function recordSignIn(req: PayloadRequest, userId: number): Promise<void> {
  try {
    // Bypass: a direct write of the server-kept sign-in time; nobody writes it through the API.
    await req.payload.db.updateOne({
      collection: 'users',
      where: { id: { equals: userId } },
      data: { lastSignInAt: new Date().toISOString() },
      returning: false,
      req,
    })
  } catch {
    req.payload.logger.warn({ msg: 'Could not record the sign-in time', userId })
  }
}

/**
 * Same timing for every failed password sign-in. Payload answers an unknown email or a locked
 * account without hashing the password, which is measurably faster than a wrong password and
 * would show which addresses have an account. Hash a throwaway password in those cases.
 */
async function equalizeLoginTiming(req: PayloadRequest, email: unknown): Promise<void> {
  if (typeof email !== 'string') return
  const user = await req.payload.db.findOne<{ id: number; lockUntil?: string | null }>({
    collection: 'users',
    where: { email: { equals: email.trim().toLowerCase() } },
    req,
  })
  const locked = Boolean(user?.lockUntil && new Date(user.lockUntil).getTime() > Date.now())
  if (!user || locked) await dummyPasswordHash(req.payload)
}

/**
 * Accounts. Sign-in with Google, an email link or a password (provisional, owner decision
 * 5 Nov 2026). Payload's local strategy (email and password) stays on for the password, with
 * email verification: a password account cannot sign in before its address is confirmed.
 * `_verified` (Payload's gate) and `emailVerifiedAt` (our record) are kept in step by a hook.
 *
 * Student personal data does NOT live here. It lives in `student-profiles`, which companies
 * cannot read. A user record only carries what is needed to sign in and to check access.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  auth: {
    // Lock the account after repeated wrong passwords.
    maxLoginAttempts: 5,
    lockTime: 15 * 60 * 1000,
    // Keep req.user shallow so it never carries populated relations.
    depth: 0,
    // The session cookie: HttpOnly (Payload default), Lax, and Secure on https in production.
    cookies: { secure: process.env.NODE_ENV === 'production', sameSite: 'Lax' },
    // Reset links last an hour and work once. Admins get an email without a link (see
    // resetEmailHTML), so a reset request looks the same whoever the address belongs to.
    forgotPassword: {
      expiration: 60 * 60 * 1000,
      generateEmailHTML: resetEmailHTML,
      generateEmailSubject: resetEmailSubject,
    },
    // A password account confirms its email before the first sign-in. The link opens
    // /{locale}/verify/{token}, a page with a button (mail scanners open links).
    verify: {
      generateEmailHTML: verifyEmailHTML,
      generateEmailSubject: verifyEmailSubject,
    },
  },
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'name', 'role', 'accountStatus'] },
  access: {
    // A user reads only their own record. Nobody can list other users, so a company cannot list
    // students. Sign-up is done by server code with `overrideAccess`, never by a public request.
    read: ({ req: { user } }): Where | boolean => {
      if (!user) return false
      if (isAdmin(user)) return true
      return { id: { equals: user.id } }
    },
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }): Where | boolean => {
      if (!user) return false
      if (isAdmin(user)) return true
      return { id: { equals: user.id } }
    },
    delete: ({ req: { user } }) => isAdmin(user),
    // Only the Konnected team can enter the Payload admin panel.
    admin: ({ req: { user } }) => isAdmin(user),
  },
  // Payload's "create first user" endpoint runs with access control off. On an empty database it
  // would let anyone register as the first user. Admins come from the allowlist and the seed
  // script, so this endpoint is closed. Custom endpoints take precedence over the default one.
  endpoints: [
    {
      path: '/first-register',
      method: 'post',
      handler: () => Response.json({ message: 'Not available' }, { status: 403 }),
    },
    // Payload's own verify endpoint sets `_verified` straight in the database. This one does the
    // same through confirmEmailToken, which also records `emailVerifiedAt`.
    {
      path: '/verify/:token',
      method: 'post',
      handler: async (req) => {
        const token = String(req.routeParams?.token ?? '')
        const ok = await confirmEmailToken(req.payload, token)
        return ok
          ? Response.json({ message: 'Email verified successfully.' })
          : Response.json(
              { errors: [{ message: 'Verification token is invalid.' }] },
              { status: 403 },
            )
      },
    },
  ],
  hooks: {
    beforeOperation: [
      async ({ args, operation, req }) => {
        if (operation === 'login') await equalizeLoginTiming(req, args.data?.email)
        // A reset link proves the address, like a confirmation link (see beforeValidate).
        if (operation === 'resetPassword') req.context.passwordReset = true
        return args
      },
    ],
    beforeValidate: [
      ({ data, req }) => {
        if (data && req.context.passwordReset) {
          data._verified = true
          data.emailVerifiedAt ??= new Date().toISOString()
          // Payload's reset writes the whole row straight to the database after this hook, so
          // the password bookkeeping for a reset happens here, not in beforeChange. A reset on
          // an account that had no password of its own (Google or email-link only) adds a way to
          // sign in: the email and notice follow in afterOperation.
          if (!data.passwordSetAt) {
            data.methodAddedNotice = 'password'
            ;(req.context as AccountContext).methodAdded = 'password'
          }
          data.passwordSetAt = new Date().toISOString()
        }
        return data
      },
    ],
    // Admins sign in with Google only (owner decision, 5 Nov 2026), by role and by the
    // ADMIN_EMAILS list. Payload runs this after the password check, so the error is the same
    // generic one a wrong password gets. It also stops a reset link from signing an admin in.
    beforeLogin: [
      ({ req, user }) => {
        if (user?.role === 'admin' || isAdminEmail(user?.email)) {
          throw new AuthenticationError(req.t)
        }
        // A paused account cannot sign in. This runs after the password check, so only the
        // person who knows the password learns that the account is paused.
        if (isPaused(user)) throw new AccountPausedError()
        return user
      },
      // `user` is the copy Payload read before checking the password. A pause can land while
      // the password is hashed: read the status again, inside the sign-in's transaction, after
      // its session write (which the database refused for a paused account). Throwing here rolls
      // the sign-in back.
      async ({ req, user }) => {
        const fresh = await req.payload.db.findOne<{ id: number; accountStatus?: string | null }>({
          collection: 'users',
          where: { id: { equals: user.id } },
          select: { accountStatus: true },
          req,
        })
        if (!fresh || isPaused(fresh)) throw new AccountPausedError()
        return user
      },
    ],
    afterLogin: [
      async ({ req, user }) => {
        await recordSignIn(req, user.id)
        return user
      },
    ],
    // The email and log row for a password set through a reset link (see beforeValidate).
    afterOperation: [
      async ({ operation, req, result }) => {
        const added = (req.context as AccountContext).methodAdded
        if (operation !== 'resetPassword' || !added) return result
        const user = (result as unknown as { user?: User } | undefined)?.user
        if (user) await announceMethodAdded(req, user, added)
        return result
      },
    ],
    // Payload's "account locked" error would tell a stranger that the address has an account.
    // Answer with the same error as a wrong password.
    afterError: [
      ({ error, req }) => {
        if (error.name !== 'LockedAuth') return
        const generic = new AuthenticationError(req.t)
        return { status: generic.status, response: { errors: [{ message: generic.message }] } }
      },
    ],
    beforeChange: [
      ({ data, originalDoc }) => {
        // Keep Payload's `_verified` and our `emailVerifiedAt` in step: either one proves the
        // address. Field access still applies afterwards, so only server code or an admin can
        // set them.
        if (data.emailVerifiedAt && !originalDoc?._verified) data._verified = true
        if (data._verified === true && !data.emailVerifiedAt && !originalDoc?.emailVerifiedAt) {
          data.emailVerifiedAt = new Date().toISOString()
        }

        const role = data.role ?? originalDoc?.role
        if (role === 'admin') {
          const email: string | undefined = data.email ?? originalDoc?.email
          const verified = data.emailVerifiedAt ?? originalDoc?.emailVerifiedAt
          if (!isAdminEmail(email) || !verified) {
            throw new APIError('admin needs a verified email that is on the ADMIN_EMAILS list', 403)
          }
        }
        return data
      },
      // Role fixes, pausing, the name and the sign-in method bookkeeping.
      async ({ data, originalDoc, operation, req }) => {
        const context = req.context as AccountContext
        const actor = req.user
        const actorRole = effectiveRole(actor)

        if (typeof data.name === 'string') data.name = data.name.trim().slice(0, NAME_MAX) || null

        if (operation === 'create') {
          assertInitialStatus<AccountStatus>('active', data.accountStatus, 'A new account')
          data.accountStatus = 'active'
        } else if (data.accountStatus && data.accountStatus !== originalDoc?.accountStatus) {
          // Mark this as a change made from the current row (see `accountStatusVersion`).
          data.accountStatusVersion = (Number(originalDoc?.accountStatusVersion) || 0) + 1
        }
        if (operation === 'update' && actor) {
          // Server code without a signed-in user (the sign-in code) sets roles itself, under the
          // admin rule above. A signed-in user's change follows the maps in transitions.ts.
          const fromRole = originalDoc?.role as Role
          const toRole = (data.role ?? fromRole) as Role
          if (fromRole !== toRole) {
            assertTransition(ROLE_TRANSITIONS, fromRole, toRole, actorRole, 'Role')
            if (actorRole === 'admin' && (await workCount(req, originalDoc)) > 0) {
              throw new APIError(
                'Role: not possible once the account has applications or projects',
                409,
              )
            }
          }

          const fromStatus = (originalDoc?.accountStatus ?? 'active') as AccountStatus
          const toStatus = (data.accountStatus ?? fromStatus) as AccountStatus
          if (fromStatus !== toStatus) {
            assertTransition(ACCOUNT_TRANSITIONS, fromStatus, toStatus, actorRole, 'Account')
            // Team accounts come from the ADMIN_EMAILS list; take an address off the list
            // instead. This also keeps a team member from locking themselves out.
            if (toStatus === 'paused' && (toRole === 'admin' || isAdminEmail(originalDoc?.email))) {
              throw new APIError('Account: a team account cannot be paused', 403)
            }
          }

          // Only the person can see and clear their own notice; nobody but the server sets it.
          if (!isAdmin(actor) && data.methodAddedNotice) {
            data.methodAddedNotice = originalDoc?.methodAddedNotice ?? null
          }
        }

        // A password the person chose (sign-up, the admin panel, Payload's own endpoints) is a
        // way to sign in. A random one from the server (Google or link accounts, or replacing a
        // password nobody proved) is not, and clears the record.
        if (typeof data.password === 'string' && data.password) {
          if (context.generatedPassword) {
            data.passwordSetAt = null
          } else {
            if (operation === 'update' && !originalDoc?.passwordSetAt) {
              data.methodAddedNotice = 'password'
              context.methodAdded = 'password'
            }
            data.passwordSetAt = new Date().toISOString()
          }
        }

        // Google linked to an account that already existed.
        if (operation === 'update' && data.googleSub && !originalDoc?.googleSub) {
          data.methodAddedNotice = 'google'
          context.methodAdded = 'google'
        }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'role', alsoLog: ['accountStatus'] }),
      async ({ doc, previousDoc, operation, req }) => {
        const context = req.context as AccountContext
        if (context.methodAdded && operation === 'update') {
          const method = context.methodAdded
          // One announcement per change, even if Payload runs the hooks again on this request.
          delete context.methodAdded
          await announceMethodAdded(req, doc, method)
        }
        if (operation !== 'update' || !previousDoc) return doc

        if (doc.accountStatus !== previousDoc.accountStatus) {
          if (doc.accountStatus === 'paused') {
            await endAllSessions(req, doc.id)
            await announcePaused(req, doc)
          } else {
            await announceReactivated(req, doc)
          }
        }

        // A role fix by the team (student <-> company; the hook above allowed nothing else).
        const from = previousDoc.role
        const to = doc.role
        if (
          from !== to &&
          (from === 'student' || from === 'company') &&
          (to === 'student' || to === 'company')
        ) {
          await removeOldRoleData(req, previousDoc, from)
          await announceRoleChanged(req, doc, to)
        }
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      // The person's name, shown in the account menu and to the team. Students give it in the
      // onboarding (copied from their profile), companies as the contact person, and team
      // members get it from Google. Only the person and the team read it (collection access);
      // companies can never read users.
      name: 'name',
      type: 'text',
      maxLength: NAME_MAX,
    },
    {
      // Payload's email, made admin-only to change (merged with Payload's base email field).
      // Email-link and Google sign-in link to an existing account by email, so a user who could
      // set their own email to someone else's address, with no proof, would have that person
      // land in their account later, or become admin when a newly listed admin first signs in.
      // A self-service email change would need to clear `emailVerifiedAt`, `_verified` and
      // `googleSub` and confirm the new address first.
      name: 'email',
      type: 'email',
      access: { update: adminOnlyField },
    },
    {
      // Payload's password, with the Konnected rules: 15 to 256 characters and not in a known
      // breach (src/lib/auth/password.ts). Virtual: only the hash and salt are stored. Payload
      // runs this on create, update and reset-password.
      name: 'password',
      type: 'text',
      virtual: true,
      hidden: true,
      admin: { hidden: true },
      validate: validatePassword as never,
    },
    {
      // Payload's verification flag, made admin-only to write. Payload's default would let any
      // signed-in user set it on their own record.
      name: '_verified',
      type: 'checkbox',
      access: { read: selfOrAdmin, create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      // A new account is `pending` (no access to anything) until the user picks student or
      // company. Fail closed: a missing role must never mean a working one.
      defaultValue: 'pending',
      options: ['admin', 'student', 'company', 'pending'],
      index: true,
      saveToJWT: true,
      // Nobody can pick or change a role through the API. Server code sets it.
      access: { create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'company',
      type: 'relationship',
      relationTo: 'companies',
      // One person per company account: no two users can point at the same company. (Postgres
      // allows many NULLs, so students and admins are not affected.)
      unique: true,
      index: true,
      // Set only by the server, from `companies.user` (see Companies): when a company user
      // registers, or when an admin changes a company's user there. Nobody writes it through the
      // API, so the two links cannot disagree.
      access: {
        read: ({ req: { user }, id }) => isAdmin(user) || user?.id === id,
        create: () => false,
        update: () => false,
      },
      admin: { readOnly: true },
    },
    {
      name: 'language',
      type: 'select',
      defaultValue: 'en',
      options: ['en', 'no'],
    },
    {
      // The Google account id (`sub`). Optional: only users who signed in with Google have one.
      name: 'googleSub',
      type: 'text',
      unique: true,
      index: true,
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
    },
    {
      // Active, or paused by the Konnected team (misuse or a security worry). A paused account
      // cannot sign in and its access functions return nothing. Changed only by the team, through
      // ACCOUNT_TRANSITIONS in the hook above.
      name: 'accountStatus',
      type: 'select',
      // Not `required` so creates need not send it: the default and the hook set `active`, and an
      // empty value counts as active everywhere (isActive checks for `paused` only).
      defaultValue: 'active',
      options: ['active', 'paused'],
      index: true,
      access: { create: adminOnlyField, update: adminOnlyField },
    },
    {
      // Goes up by one with every change of `accountStatus` (the hook above). Payload writes the
      // whole user row from the copy it read when an operation began (a sign-in, a profile save,
      // a sign-out), so a write that started before a pause would put `active` back. The database
      // keeps the stored status when the write carries an older version than the row's
      // (migration 20261106_210116_accounts_hold_against_stale_writes). Never shown.
      name: 'accountStatusVersion',
      type: 'number',
      defaultValue: 0,
      hidden: true,
      access: { create: () => false, update: adminOnlyField },
    },
    {
      // Sessions started before this time are void ("Sign out everywhere", a pause). Written only
      // by revokeAllSessions. The database never moves it back and never stores a session row that
      // is older, or any session row of a paused account, so a stale whole-row write cannot bring
      // an ended session back (same migration). Never shown.
      name: 'sessionsValidAfter',
      type: 'date',
      hidden: true,
      access: { create: () => false, update: () => false },
    },
    {
      // When the person chose a password. Empty for Google and email-link accounts, whose
      // password is random and unknown to anyone.
      name: 'passwordSetAt',
      type: 'date',
      access: { read: selfOrAdmin, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true },
    },
    {
      // The last time a session was started, by any method.
      name: 'lastSignInAt',
      type: 'date',
      access: { read: selfOrAdmin, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true },
    },
    {
      // A way to sign in that was added and not yet shown to the person. Set only by the server
      // (see the hook); the person clears it by closing the notice.
      name: 'methodAddedNotice',
      type: 'select',
      options: ['google', 'password'],
      access: { read: selfOrAdmin, create: adminOnlyField, update: selfOrAdmin },
      admin: { readOnly: true },
    },
    {
      // Set by the server when an email is proven (Google email_verified, a clicked magic link).
      name: 'emailVerifiedAt',
      type: 'date',
      access: {
        read: ({ req: { user }, id }) => isAdmin(user) || user?.id === id,
        create: adminOnlyField,
        update: adminOnlyField,
      },
    },
  ],
}
