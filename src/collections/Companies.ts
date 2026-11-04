import type { Where } from 'payload'
import type { CollectionConfig } from 'payload'

import { adminOnlyField, companyIdOf, isAdmin, isCompany } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  assertInitialStatus,
  assertTransition,
  COMPANY_TRANSITIONS,
  type CompanyStatus,
} from '@/lib/transitions'

export const Companies: CollectionConfig = {
  slug: 'companies',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'status'] },
  access: {
    // Students never read companies. They see only `companyName` on a published project.
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      return companyId ? { id: { equals: companyId } } : false
    },
    // A company user can create exactly one company, which starts as pending.
    create: ({ req: { user } }) => isAdmin(user) || (isCompany(user) && !companyIdOf(user)),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      return companyId ? { id: { equals: companyId } } : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      ({ data, originalDoc, operation, req }) => {
        const role = req.user?.role
        if (operation === 'create') {
          assertInitialStatus<CompanyStatus>('pending', data.status, 'A new company')
          data.status = 'pending'
          return data
        }
        const from = originalDoc?.status as CompanyStatus
        const to = (data.status ?? from) as CompanyStatus
        assertTransition(COMPANY_TRANSITIONS, from, to, role, 'Company')
        return data
      },
    ],
    afterChange: [
      async ({ doc, operation, req }) => {
        // Link the company user to the company they just created. Bypass: `users.company` is
        // admin-only in the API, so the server sets it. Only a company-role user with no company
        // can reach `create`, and this runs once per company.
        if (operation === 'create' && isCompany(req.user)) {
          await req.payload.update({
            collection: 'users',
            id: req.user!.id,
            data: { company: doc.id },
            overrideAccess: true,
            req,
          })
        }
        return doc
      },
      logActivityAfterChange({ statusField: 'status' }),
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'description', type: 'textarea' },
    { name: 'sector', type: 'text' },
    // The logo upload comes with the file storage decision (open).
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: ['pending', 'approved', 'rejected'],
      // Only the Konnected team approves or rejects a company.
      access: { create: adminOnlyField, update: adminOnlyField },
    },
  ],
}
