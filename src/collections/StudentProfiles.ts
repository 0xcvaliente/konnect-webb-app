import type { Where } from 'payload'
import type { CollectionConfig } from 'payload'

import { adminOnlyField, adminOrStudentField, isAdmin, isStudent } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'

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
      ({ data, operation, req }) => {
        // A student can only create a profile for themselves. The client cannot choose the user.
        if (operation === 'create' && isStudent(req.user)) {
          data.user = req.user!.id
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
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
    // CV upload comes with the file storage decision (open).
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
      ],
    },
  ],
}
