import type { CollectionConfig, Where } from 'payload'

import { adminOnlyField, isAdmin, isCompany, isStudent, relationId } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import {
  cleanText,
  FEEDBACK_SIDES,
  FEEDBACK_TEXT_MAX,
  isRating,
  RATING_MAX,
  RATING_MIN,
} from '@/lib/feedback/fields'
import { feedbackError, feedbackTarget } from '@/lib/feedback/rules'

type Rel = number | { id: number } | null | undefined

/**
 * Feedback after a project (lib/feedback/fields.ts): once per project from the student Konnected
 * selected and once from the company, after the project closed with its work delivered.
 *
 * Read: admins all; the author only their own answers (to show "sent"). A company never reads
 * the student's feedback and a student never reads the company's. Create: a student or a company,
 * for themselves only; the project, side, match and author come from the session and the stored
 * records. Nobody changes feedback once sent (it is what was said). Delete: admins (for example
 * for a data request).
 */
export const Feedback: CollectionConfig = {
  slug: 'feedback',
  labels: { singular: 'Feedback', plural: 'Feedback' },
  // "Feedback" has no plural of its own: name the GraphQL queries explicitly.
  graphQL: { singularName: 'FeedbackEntry', pluralName: 'FeedbackEntries' },
  admin: { defaultColumns: ['project', 'side', 'rating', 'createdAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user) || isCompany(user)) return { author: { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isStudent(user) || isCompany(user),
    update: () => false,
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, operation, req }) => {
        if (operation !== 'create') return data
        const projectId = relationId(data.project as Rel)
        if (projectId) await lockRow(req, 'projects', projectId)
        const target = await feedbackTarget(req.payload, req.user, projectId, req)
        if (typeof target === 'string') {
          throw feedbackError(
            target,
            'No feedback on this project',
            target === 'forbidden' ? 403 : 404,
          )
        }
        // Once per person and project. The unique index is the last word; this gives a clear
        // answer first (the project row is locked above, so two sends run one after the other).
        const sent = await req.payload.count({
          collection: 'feedback',
          where: {
            and: [{ project: { equals: projectId } }, { author: { equals: req.user!.id } }],
          },
          overrideAccess: true,
          req,
        })
        if (sent.totalDocs > 0) throw feedbackError('already_sent', 'Feedback was sent', 409)
        const rating = typeof data.rating === 'string' ? Number(data.rating) : data.rating
        if (!isRating(rating)) throw feedbackError('rating_required', 'Pick 1 to 5', 400)
        const wentWell = cleanText(data.wentWell)
        const couldBeBetter = cleanText(data.couldBeBetter)
        if ((wentWell?.length ?? 0) > FEEDBACK_TEXT_MAX) throw feedbackError('too_long', 'Too long')
        if ((couldBeBetter?.length ?? 0) > FEEDBACK_TEXT_MAX)
          throw feedbackError('too_long', 'Too long')
        return {
          project: target.projectId,
          match: target.matchId,
          side: target.side,
          author: req.user!.id,
          rating,
          wentWell,
          couldBeBetter,
          again: data.again === true,
        }
      },
    ],
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  indexes: [{ fields: ['project', 'author'], unique: true }],
  fields: [
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      required: true,
      index: true,
    },
    {
      // The student's match (student feedback). Team only.
      name: 'match',
      type: 'relationship',
      relationTo: 'matches',
      access: { read: adminOnlyField },
    },
    {
      // Set by the server, like the author (not required: validation runs before the hook).
      name: 'side',
      type: 'select',
      options: [...FEEDBACK_SIDES],
    },
    {
      name: 'author',
      type: 'relationship',
      relationTo: 'users',
      index: true,
    },
    { name: 'rating', type: 'number', required: true, min: RATING_MIN, max: RATING_MAX },
    { name: 'wentWell', type: 'textarea', maxLength: FEEDBACK_TEXT_MAX },
    { name: 'couldBeBetter', type: 'textarea', maxLength: FEEDBACK_TEXT_MAX },
    { name: 'again', label: 'Would do it again', type: 'checkbox', defaultValue: false },
  ],
}
