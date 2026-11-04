import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrCompanyField,
  companyIdOf,
  isAdmin,
  isCompany,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  assertInitialStatus,
  assertTransition,
  PROJECT_TRANSITIONS,
  type ProjectStatus,
} from '@/lib/transitions'

export const PROJECT_STATUSES: ProjectStatus[] = [
  'draft',
  'submitted',
  'changes_requested',
  'rejected',
  'approved',
  'published',
  'matched',
  'in_progress',
  'delivered',
  'closed',
]

export const Projects: CollectionConfig = {
  slug: 'projects',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'companyName', 'status'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      // Students see only published projects.
      if (isStudent(user)) return { status: { equals: 'published' } }
      const companyId = companyIdOf(user)
      return companyId ? { company: { equals: companyId } } : false
    },
    // A company with a company record can create a draft. Submitting needs an approved company.
    create: ({ req: { user } }) => isAdmin(user) || Boolean(companyIdOf(user)),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      // A company edits its own project only while it is a draft or needs changes.
      return companyId
        ? {
            and: [
              { company: { equals: companyId } },
              { status: { in: ['draft', 'changes_requested'] } },
            ],
          }
        : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = req.user?.role

        if (operation === 'create') {
          assertInitialStatus<ProjectStatus>('draft', data.status, 'A new project')
          data.status = 'draft'
          // A company user can only create projects for their own company.
          if (isCompany(req.user)) data.company = companyIdOf(req.user)
        }

        const from = (originalDoc?.status ?? 'draft') as ProjectStatus
        const to = (data.status ?? from) as ProjectStatus
        if (operation === 'update') {
          assertTransition(PROJECT_TRANSITIONS, from, to, role, 'Project')
        }

        const companyId = relationId(data.company ?? originalDoc?.company)
        if (!companyId) throw new APIError('A project needs a company', 400)

        // Bypass: read the company with overrideAccess because students (who read projects) and
        // the acting user may not be allowed to read the company. Only name and status are used.
        const company = await req.payload.findByID({
          collection: 'companies',
          id: companyId,
          depth: 0,
          overrideAccess: true,
          req,
        })

        // A company that is not approved cannot submit a project.
        if (to === 'submitted' && from !== 'submitted' && company.status !== 'approved') {
          throw new APIError('Only an approved company can submit a project', 403)
        }

        // Students never read the company record. They see this copy of the name.
        data.companyName = company.name
        return data
      },
    ],
    afterChange: [logActivityAfterChange({ statusField: 'status' })],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'company',
      type: 'relationship',
      relationTo: 'companies',
      required: true,
      index: true,
      access: { read: adminOrCompanyField, update: adminOnlyField },
    },
    {
      // Copy of the company name, set by the server, so students need no access to companies.
      // The beforeChange hook overwrites it on every save, so a client value never sticks. No
      // field-level access here: that is applied after the hook and would drop the server's value.
      name: 'companyName',
      type: 'text',
      admin: { readOnly: true },
    },
    { name: 'title', type: 'text', required: true },
    { name: 'description', type: 'textarea', required: true },
    { name: 'tasks', type: 'textarea' },
    { name: 'deliverable', type: 'textarea' },
    { name: 'desiredSkills', type: 'text', hasMany: true },
    { name: 'workload', type: 'text' },
    { name: 'duration', type: 'text' },
    { name: 'location', type: 'text' },
    // The fee model is undecided. This is the fee shown to students, entered by the company or
    // Konnected. No price or percentage is built in.
    { name: 'fee', type: 'number', min: 0 },
    { name: 'deadline', type: 'date' },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: PROJECT_STATUSES,
    },
  ],
}
