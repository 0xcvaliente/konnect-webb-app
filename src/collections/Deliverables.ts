import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import { adminOnlyField, companyIdOf, isAdmin, isStudent, relationId } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { MAX_DELIVERABLE_FILES } from './DeliverableFiles'
import {
  assertInitialStatus,
  assertTransition,
  DELIVERABLE_TRANSITIONS,
  type DeliverableStatus,
} from '@/lib/transitions'

/**
 * Work a student hands in for a match. The student uploads. A company sees a deliverable only
 * after Konnected releases it, and only for its own projects. A deliverable lists up to 10 files
 * (`deliverable-files`, uploaded first for the same match), plus links and a note.
 */
export const Deliverables: CollectionConfig = {
  slug: 'deliverables',
  admin: { defaultColumns: ['match', 'status', 'submittedAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'match.student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId
        ? {
            and: [
              { 'match.project.company': { equals: companyId } },
              { status: { equals: 'released' } },
            ],
          }
        : false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      // A student edits their own deliverable only until Konnected releases it.
      if (isStudent(user)) {
        return {
          and: [
            { 'match.student.user': { equals: user!.id } },
            { status: { equals: 'submitted' } },
          ],
        }
      }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = req.user?.role

        if (operation === 'create') {
          assertInitialStatus<DeliverableStatus>('submitted', data.status, 'A new deliverable')
          data.status = 'submitted'
          data.submittedAt = new Date().toISOString()

          if (role === 'student') {
            // Bypass: check the match belongs to this student. The student may not read all matches.
            const match = await req.payload.findByID({
              collection: 'matches',
              id: relationId(data.match) as number,
              depth: 1,
              overrideAccess: true,
              req,
            })
            const profile = typeof match.student === 'object' ? match.student : null
            if (!profile || relationId(profile.user) !== req.user!.id) {
              throw new APIError('This match is not yours', 403)
            }
          }
          return data
        }

        const from = originalDoc?.status as DeliverableStatus
        const to = (data.status ?? from) as DeliverableStatus
        assertTransition(DELIVERABLE_TRANSITIONS, from, to, role, 'Deliverable')
        return data
      },
      async ({ data, originalDoc, req }) => {
        // Every file must have been uploaded for this deliverable's match. Bypass: the server
        // reads the files' match, whatever the acting user may read.
        const fileIds = (data.files ?? []).map(relationId).filter(Boolean) as number[]
        if (!fileIds.length) return data
        const matchId = relationId(data.match ?? originalDoc?.match)
        const files = await req.payload.find({
          collection: 'deliverable-files',
          where: { id: { in: fileIds } },
          depth: 0,
          pagination: false,
          overrideAccess: true,
          req,
        })
        const ok = new Set(
          files.docs.filter((f) => relationId(f.match) === matchId).map((f) => f.id),
        )
        if (fileIds.some((id) => !ok.has(id))) {
          throw new APIError('A file does not belong to this match', 403)
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange({ statusField: 'status' })],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'match',
      type: 'relationship',
      relationTo: 'matches',
      required: true,
      index: true,
      access: { update: adminOnlyField },
    },
    { name: 'note', type: 'textarea' },
    {
      name: 'files',
      type: 'upload',
      relationTo: 'deliverable-files',
      hasMany: true,
      maxRows: MAX_DELIVERABLE_FILES,
    },
    {
      name: 'links',
      type: 'array',
      fields: [
        { name: 'label', type: 'text' },
        { name: 'url', type: 'text', required: true },
      ],
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'submitted',
      index: true,
      options: ['submitted', 'released'],
      // Only the Konnected team releases a deliverable to the company.
      access: { update: adminOnlyField },
    },
    { name: 'submittedAt', type: 'date', admin: { readOnly: true } },
  ],
}
