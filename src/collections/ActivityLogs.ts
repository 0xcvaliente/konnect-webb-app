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
      options: ['create', 'status_change', 'delete'],
    },
    { name: 'targetCollection', type: 'text', required: true, index: true },
    { name: 'targetId', type: 'text', required: true },
    { name: 'fromStatus', type: 'text' },
    { name: 'toStatus', type: 'text' },
  ],
}
