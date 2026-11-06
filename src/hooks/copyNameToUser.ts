import type { CollectionAfterChangeHook } from 'payload'

import { relationId } from '@/access/roles'

/**
 * Keep the account's name (`users.name`, shown in the account menu and to the team) in step with
 * the name the person gave in their onboarding: the student profile's name, or the company's
 * contact person. Runs on create and on every change of that field, whoever made it.
 *
 * Bypass: the server writes the copy with `overrideAccess: true`; the acting user may be a team
 * member who cannot act as the account's owner. Only the name is copied, in the same transaction.
 */
export const copyNameToUser =
  (field: string): CollectionAfterChangeHook =>
  async ({ doc, previousDoc, operation, req }) => {
    const name = (doc as Record<string, unknown>)[field]
    const before = (previousDoc as Record<string, unknown> | undefined)?.[field]
    const userId = relationId((doc as { user?: number | { id: number } | null }).user)
    if (!userId || typeof name !== 'string' || !name.trim()) return doc
    if (operation === 'update' && name === before) return doc
    await req.payload.update({
      collection: 'users',
      id: userId,
      data: { name },
      depth: 0,
      overrideAccess: true,
      req,
    })
    return doc
  }
