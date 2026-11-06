import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrStudentField,
  effectiveRole,
  isAdmin,
  isStudent,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  APPLICATION_TRANSITIONS,
  assertInitialStatus,
  assertTransition,
  type ApplicationStatus,
} from '@/lib/transitions'

/**
 * A student's application to a project. Companies have no access at all, so a company never learns
 * who applied. A student reads and withdraws only their own applications.
 *
 * Unique on (student, project) in the database. See the migration. This also stops two
 * simultaneous requests.
 */
export const Applications: CollectionConfig = {
  slug: 'applications',
  admin: { defaultColumns: ['project', 'student', 'status'] },
  indexes: [{ fields: ['student', 'project'], unique: true }],
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = effectiveRole(req.user)

        if (operation === 'create') {
          assertInitialStatus<ApplicationStatus>('applied', data.status, 'A new application')
          data.status = 'applied'

          if (role === 'student') {
            // The applicant always comes from the session, never from the request body.
            // Bypass: a student cannot read all profiles, so look up their own by user id.
            const profiles = await req.payload.find({
              collection: 'student-profiles',
              where: { user: { equals: req.user!.id } },
              limit: 1,
              depth: 0,
              overrideAccess: true,
              req,
            })
            const profile = profiles.docs[0]
            if (!profile) throw new APIError('Create your profile before you apply', 400)
            data.student = profile.id
          }

          // Bypass: read the project's status only. A project must be published to be applied to.
          const projectId = data.project
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: typeof projectId === 'object' ? projectId.id : projectId,
                depth: 0,
                overrideAccess: true,
                req,
              })
            : null
          if (!project || project.status !== 'published') {
            throw new APIError('You can only apply to a published project', 400)
          }
          return data
        }

        const from = originalDoc?.status as ApplicationStatus
        const to = (data.status ?? from) as ApplicationStatus
        assertTransition(APPLICATION_TRANSITIONS, from, to, role, 'Application')
        return data
      },
    ],
    afterChange: [logActivityAfterChange({ statusField: 'status' })],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'student',
      type: 'relationship',
      relationTo: 'student-profiles',
      required: true,
      index: true,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      required: true,
      index: true,
      access: { update: adminOnlyField },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'applied',
      index: true,
      options: ['applied', 'shortlisted', 'selected', 'not_selected', 'withdrawn'],
    },
    { name: 'note', type: 'textarea' },
  ],
}
