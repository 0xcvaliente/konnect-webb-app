import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import { adminOnlyField, adminOrStudentField, isAdmin, isStudent, relationId } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'

/** Fields copied to a match's `sharedInfo`. A change to any of them refreshes the copies. */
const SHARED_SOURCE_FIELDS = ['name', 'pitch', 'skills', 'experience', 'cv', 'privacy'] as const

/**
 * ALL student personal data lives here and nowhere else. Admin reads everything. A student reads
 * and edits only their own profile. Companies get no access at all, so a populated relation at any
 * depth cannot leak anything from this collection. A selected student's agreed information reaches
 * the company as a copy on the match (see Matches), never through this collection.
 *
 * Every personal field also has field-level read access as a second layer.
 */
const personal = { read: adminOrStudentField }

export const StudentProfiles: CollectionConfig = {
  slug: 'student-profiles',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'school', 'programme'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { user: { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { user: { equals: user!.id } }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        // A student can only create a profile for themselves. The client cannot choose the user.
        if (operation === 'create' && isStudent(req.user)) {
          data.user = req.user!.id
        }

        // The CV on a profile must be one the profile's student uploaded. Bypass: the server
        // reads the CV's owner, which the acting user may not be allowed to read.
        const cvId = relationId(data.cv)
        if (cvId && cvId !== relationId(originalDoc?.cv)) {
          const cv = await req.payload.findByID({
            collection: 'cvs',
            id: cvId,
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (!cv || relationId(cv.owner) !== relationId(data.user ?? originalDoc?.user)) {
            throw new APIError('This CV does not belong to this student', 403)
          }
        }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange(),
      async ({ doc, previousDoc, operation, req }) => {
        // Keep what companies see in step with what the student shares now: ticking "share my
        // CV" after selection shares it, unticking stops it. Bypass: the server rebuilds the
        // copy on each of this student's matches (see Matches); the student cannot edit matches.
        if (operation !== 'update') return doc
        const changed = SHARED_SOURCE_FIELDS.some(
          (key) => JSON.stringify(doc[key] ?? null) !== JSON.stringify(previousDoc?.[key] ?? null),
        )
        if (!changed) return doc
        const matches = await req.payload.find({
          collection: 'matches',
          where: { student: { equals: doc.id } },
          depth: 0,
          pagination: false,
          overrideAccess: true,
          req,
        })
        for (const match of matches.docs) {
          await req.payload.update({
            collection: 'matches',
            id: match.id,
            data: {},
            overrideAccess: true,
            req,
          })
        }
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      unique: true,
      index: true,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    { name: 'name', type: 'text', required: true, access: personal },
    { name: 'school', type: 'text', access: personal },
    { name: 'programme', type: 'text', access: personal },
    { name: 'year', type: 'number', min: 1, max: 10, access: personal },
    { name: 'pitch', type: 'textarea', access: personal },
    { name: 'skills', type: 'text', hasMany: true, access: personal },
    { name: 'interests', type: 'text', hasMany: true, access: personal },
    { name: 'experience', type: 'textarea', access: personal },
    { name: 'highlights', type: 'textarea', access: personal },
    { name: 'preferredProjectTypes', type: 'text', hasMany: true, access: personal },
    {
      // The student's current CV (see the `cvs` collection: PDF only, 10 MB, private).
      name: 'cv',
      type: 'upload',
      relationTo: 'cvs',
      access: personal,
      // Admin panel helper only. The hook above is the real check.
      filterOptions: ({ data }) => ({ owner: { equals: relationId(data?.user) ?? 0 } }),
    },
    { name: 'contactEmail', type: 'email', access: personal },
    { name: 'phone', type: 'text', access: personal },
    {
      // What the student agrees to share with a company after Konnected selects them.
      // Nothing is shared by default.
      name: 'privacy',
      type: 'group',
      access: personal,
      fields: [
        { name: 'shareName', type: 'checkbox', defaultValue: false },
        { name: 'sharePitch', type: 'checkbox', defaultValue: false },
        { name: 'shareSkills', type: 'checkbox', defaultValue: false },
        { name: 'shareExperience', type: 'checkbox', defaultValue: false },
        { name: 'shareCv', type: 'checkbox', defaultValue: false },
      ],
    },
  ],
}
