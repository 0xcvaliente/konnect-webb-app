import type { PayloadRequest, Where } from 'payload'
import { APIError, AuthenticationError, type CollectionConfig } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { adminOnlyField, isAdmin } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { dummyPasswordHash, validatePassword } from '@/lib/auth/password'
import { confirmEmailToken } from '@/lib/auth/verification'
import {
  resetEmailHTML,
  resetEmailSubject,
  verifyEmailHTML,
  verifyEmailSubject,
} from '@/lib/email/authEmails'

const selfOrAdmin = ({ req: { user }, id }: { req: PayloadRequest; id?: number | string }) =>
  isAdmin(user) || (user != null && user.id === id)

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
  admin: { useAsTitle: 'email', defaultColumns: ['email', 'role'] },
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
        return user
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
    ],
    afterChange: [logActivityAfterChange({ statusField: 'role' })],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
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
