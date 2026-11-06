import type { Where } from 'payload'
import { APIError, AuthenticationError, type CollectionConfig } from 'payload'

import { isAdminEmail } from '@/access/adminEmails'
import { adminOnlyField, isAdmin } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { resetEmailHTML, resetEmailSubject } from '@/lib/email/passwordReset'

/**
 * Accounts. Sign-in methods (Google, magic link, password) are provisional and belong to the auth
 * card. This collection keeps Payload's local strategy (email and password) enabled.
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
  ],
  hooks: {
    // Admins sign in with Google only (owner decision, 5 Nov 2026). Payload runs this after the
    // password check, so the error is the same generic one a wrong password gets.
    beforeLogin: [
      ({ req, user }) => {
        if (user?.role === 'admin') throw new AuthenticationError(req.t)
        return user
      },
    ],
    beforeChange: [
      ({ data, originalDoc }) => {
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
      index: true,
      // Set by the server when a company user creates their company.
      access: {
        read: ({ req: { user }, id }) => isAdmin(user) || user?.id === id,
        create: adminOnlyField,
        update: adminOnlyField,
      },
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
