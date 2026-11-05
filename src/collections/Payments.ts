import type { Where } from 'payload'
import type { CollectionConfig } from 'payload'

import { adminOnlyField, companyIdOf, isAdmin } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'

/**
 * Manual payment log. Version 1 has no payment provider and the fee model is undecided, so these
 * are plain numbers and dates that the Konnected team fills in. Nothing is calculated here.
 *
 * Admin reads and writes everything. A company reads a summary for its own projects only:
 * the project fee and whether the invoice was sent and paid. The Konnected share and the student
 * pay are admin-only fields. Students have no access.
 */
export const Payments: CollectionConfig = {
  slug: 'payments',
  admin: { defaultColumns: ['match', 'projectFee', 'invoiceSentAt', 'invoicePaidAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      return companyId ? { 'match.project.company': { equals: companyId } } : false
    },
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  indexes: [{ fields: ['match'], unique: true }],
  fields: [
    { name: 'match', type: 'relationship', relationTo: 'matches', required: true, index: true },
    { name: 'projectFee', type: 'number', min: 0 },
    { name: 'konnectedShare', type: 'number', min: 0, access: { read: adminOnlyField } },
    { name: 'studentPay', type: 'number', min: 0, access: { read: adminOnlyField } },
    { name: 'invoiceSentAt', type: 'date' },
    { name: 'invoicePaidAt', type: 'date' },
    { name: 'studentPaidAt', type: 'date', access: { read: adminOnlyField } },
  ],
}
