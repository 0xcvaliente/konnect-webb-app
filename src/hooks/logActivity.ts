import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionSlug,
  PayloadRequest,
} from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import type { ActivityLog } from '@/payload-types'

type Options = {
  /** The field that holds the workflow state. A change to it is logged as a status change. */
  statusField?: string
  /**
   * More fields whose changes are logged as status changes, each in its own row with the field
   * name (users: `accountStatus` next to `role`). Only on updates.
   */
  alsoLog?: string[]
}

/** Context keys hooks read. `activityNote` is the team's reason, stored on the row. */
export type ActivityContext = { skipActivityLog?: boolean; activityNote?: string }

const noteOf = (req: PayloadRequest): string | undefined => {
  const note = (req.context as ActivityContext | undefined)?.activityNote
  return typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : undefined
}

/**
 * Write one activity log row. Bypass: the log is written with the default `overrideAccess: true`
 * on purpose. Nobody can create log rows through the API (`create: false`), so the server writes
 * them. Pass `req` so the row commits or rolls back with the change.
 */
export async function writeActivity(
  req: PayloadRequest,
  row: Omit<ActivityLog, 'id' | 'createdAt' | 'updatedAt' | 'actor'> & { actor?: number | null },
): Promise<void> {
  await req.payload.create({
    collection: 'activity-logs',
    req,
    data: { actor: relationId(req.user?.id) ?? null, ...row },
  })
}

/**
 * Write a row to the activity log for every create, status change and delete.
 *
 * Only ids, status values and the team's own note are logged, never document contents, so no
 * personal data from the document ends up in the log.
 */
export const logActivityAfterChange =
  (options: Options = {}): CollectionAfterChangeHook =>
  async ({ collection, doc, previousDoc, operation, req, context }) => {
    if (context?.skipActivityLog) return doc

    const valueOf = (source: unknown, key: string) =>
      String((source as Record<string, unknown> | undefined)?.[key] ?? '')
    const field = options.statusField
    const to = field ? valueOf(doc, field) : undefined
    const from = field ? valueOf(previousDoc, field) : undefined
    const statusChanged = operation === 'update' && field !== undefined && to !== from
    const note = noteOf(req)

    if (operation === 'create' || statusChanged) {
      await writeActivity(req, {
        action: operation === 'create' ? 'create' : 'status_change',
        targetCollection: collection.slug,
        targetId: String(doc.id),
        field: statusChanged && options.alsoLog?.length ? field : undefined,
        fromStatus: statusChanged ? from : undefined,
        toStatus: field ? to : undefined,
        note: statusChanged ? note : undefined,
      })
    }

    if (operation === 'update') {
      for (const extra of options.alsoLog ?? []) {
        const before = valueOf(previousDoc, extra)
        const after = valueOf(doc, extra)
        if (before === after) continue
        await writeActivity(req, {
          action: 'status_change',
          targetCollection: collection.slug,
          targetId: String(doc.id),
          field: extra,
          fromStatus: before,
          toStatus: after,
          note,
        })
      }
    }
    return doc
  }

export const logActivityAfterDelete =
  (): CollectionAfterDeleteHook =>
  async ({ collection, id, req }) => {
    await writeActivity(req, {
      action: 'delete',
      targetCollection: collection.slug as CollectionSlug,
      targetId: String(id),
    })
  }

/**
 * Write a `reassign` row when a company's or a project's owner on the team changes, or someone
 * takes an item from the shared pool (team split by company). Only user ids and the team's own
 * note (`req.context.activityNote`) are logged. A new record that starts with an owner copied from
 * its company is not a reassignment and is not logged here (its `create` row covers it).
 */
export const logReassignments =
  (fields: string[]): CollectionAfterChangeHook =>
  async ({ collection, doc, previousDoc, operation, req, context }) => {
    // Only the team changes owners (field access drops anyone else's value). A company's or a
    // student's own save is never a reassignment, even though their copy of the previous
    // document has no owner fields to compare (field read access hides them).
    if (context?.skipActivityLog || operation !== 'update' || !isAdmin(req.user)) return doc
    const note = noteOf(req)
    for (const field of fields) {
      const before = relationId((previousDoc as Record<string, never> | undefined)?.[field])
      const after = relationId((doc as Record<string, never>)[field])
      if ((before ?? null) === (after ?? null)) continue
      await writeActivity(req, {
        action: 'reassign',
        targetCollection: collection.slug,
        targetId: String(doc.id),
        field,
        fromStatus: before ? String(before) : undefined,
        toStatus: after ? String(after) : undefined,
        note,
      })
    }
    return doc
  }
