import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionSlug } from 'payload'

import { relationId } from '@/access/roles'

type Options = {
  /** The field that holds the workflow state. A change to it is logged as a status change. */
  statusField?: string
}

/**
 * Write a row to the activity log for every create, status change and delete.
 *
 * Bypass: the log is written with the default `overrideAccess: true` on purpose. Nobody can
 * create log rows through the API (`create: false`), so the server writes them. `req` is passed so
 * the row commits or rolls back with the change. Only ids and status values are logged, never
 * document contents, so no personal data ends up in the log.
 */
export const logActivityAfterChange =
  (options: Options = {}): CollectionAfterChangeHook =>
  async ({ collection, doc, previousDoc, operation, req, context }) => {
    if (context?.skipActivityLog) return doc

    const field = options.statusField
    const to = field ? String((doc as Record<string, unknown>)[field] ?? '') : undefined
    const from = field ? String((previousDoc as Record<string, unknown>)?.[field] ?? '') : undefined
    const statusChanged = operation === 'update' && field !== undefined && to !== from

    if (operation === 'update' && !statusChanged) return doc

    await req.payload.create({
      collection: 'activity-logs',
      req,
      data: {
        actor: relationId(req.user?.id) ?? null,
        action: operation === 'create' ? 'create' : 'status_change',
        targetCollection: collection.slug,
        targetId: String(doc.id),
        fromStatus: statusChanged ? from : undefined,
        toStatus: field ? to : undefined,
      },
    })
    return doc
  }

export const logActivityAfterDelete =
  (): CollectionAfterDeleteHook =>
  async ({ collection, id, req }) => {
    await req.payload.create({
      collection: 'activity-logs',
      req,
      data: {
        actor: relationId(req.user?.id) ?? null,
        action: 'delete',
        targetCollection: collection.slug as CollectionSlug,
        targetId: String(id),
      },
    })
  }
