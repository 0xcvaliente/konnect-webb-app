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
      options: ['create', 'status_change', 'delete', 'sign_out_everywhere', 'sign_in_method_added'],
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
    { name: 'note', type: 'textarea', maxLength: 500 },
  ],
}
