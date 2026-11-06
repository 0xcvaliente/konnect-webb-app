import type { CollectionConfig } from 'payload'

import { isAdmin } from '@/access/roles'

/**
 * Email sign-in links. Each row is one link: a SHA-256 hash of 32 random bytes (the token itself
 * is only in the email), the address it was sent to, when it expires (15 minutes) and when it was
 * used. A link works once: using it is one atomic UPDATE that matches only an unused, unexpired
 * row (src/lib/auth/magicLink.ts).
 *
 * Only server code creates and uses rows. Through the API nobody can create or change one, and
 * only admins can read or delete them. Hidden from the admin menu and from GraphQL.
 */
export const MagicLinks: CollectionConfig = {
  slug: 'magic-links',
  admin: { hidden: true, useAsTitle: 'email' },
  graphQL: false,
  access: {
    read: ({ req: { user } }) => isAdmin(user),
    create: () => false,
    update: () => false,
    delete: ({ req: { user } }) => isAdmin(user),
  },
  fields: [
    { name: 'tokenHash', type: 'text', required: true, unique: true, index: true },
    { name: 'email', type: 'email', required: true, index: true },
    { name: 'expiresAt', type: 'date', required: true, index: true },
    { name: 'usedAt', type: 'date' },
  ],
}
