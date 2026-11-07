import type { CollectionConfig } from 'payload'

import { isAdmin } from '@/access/roles'

/**
 * Who did what and when. Rows are written only by hooks (see hooks/logActivity.ts).
 * Nobody can create, change or delete a row through any API, and only admin can read.
 */
export const ActivityLogs: CollectionConfig = {
  slug: 'activity-logs',
  admin: { useAsTitle: 'action', defaultColumns: ['createdAt', 'action', 'targetCollection'] },
  access: {
    read: ({ req: { user } }) => isAdmin(user),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  fields: [
    { name: 'actor', type: 'relationship', relationTo: 'users', index: true },
    {
      name: 'action',
      type: 'select',
      required: true,
      // review_change: a team decision that is not a status (a project's price or paid or unpaid
      // decision, a profile reviewed again after the student changed it), with `field`, `fromStatus`
      // and `toStatus`. info_requested / info_answered: the team asked a company for more
      // information, and the company saved its corrected details. reassign: a company's or a
      // project's owner on the team changed, or someone took an item from the shared pool
      // (`field` is `teamOwner`, `owner` or `takenBy`; `fromStatus` and `toStatus` hold user ids;
      // `note` says why). away_change: a team member's away days or cover changed.
      options: [
        'create',
        'status_change',
        'delete',
        'sign_out_everywhere',
        'sign_in_method_added',
        'review_change',
        'info_requested',
        'info_answered',
        'reassign',
        'away_change',
      ],
    },
    { name: 'targetCollection', type: 'text', required: true, index: true },
    { name: 'targetId', type: 'text', required: true, index: true },
    // Which field a status change was on, when a collection logs more than one (users: `role`
    // and `accountStatus`). Empty on rows written before it existed: then it is the collection's
    // main status field.
    { name: 'field', type: 'text' },
    { name: 'fromStatus', type: 'text' },
    { name: 'toStatus', type: 'text' },
    // The team's reason for an action, for example why an account was paused. Admin-only like the
    // rest of the log. Written by the server from what the team member typed.
    // Up to 2000 characters: a review note to a company or student is kept here in full.
    { name: 'note', type: 'textarea', maxLength: 2000 },
  ],
}
