import type { CollectionConfig } from 'payload'

import { isAdmin } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { ANSWER_MAX, SAVED_TITLE_MAX } from '@/lib/questions/fields'

/**
 * The team's saved answers for Ask Konnected: questions that come back ("Can I use my own
 * tools?") get the same answer. The team picks one to fill in the answer, then edits it before
 * sending. Team only in every way.
 */
export const SavedAnswers: CollectionConfig = {
  slug: 'saved-answers',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'updatedAt'] },
  access: {
    read: ({ req: { user } }) => isAdmin(user),
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeValidate: [
      ({ data }) => {
        if (!data) return data
        for (const key of ['title', 'body'] as const) {
          if (typeof data[key] === 'string') data[key] = data[key].replace(/\r\n/g, '\n').trim()
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    { name: 'title', type: 'text', required: true, maxLength: SAVED_TITLE_MAX },
    { name: 'body', label: 'Answer', type: 'textarea', required: true, maxLength: ANSWER_MAX },
  ],
}
