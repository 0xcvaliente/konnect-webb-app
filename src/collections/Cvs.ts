import { type Access, APIError, type CollectionConfig } from 'payload'

import { cvIdsSharedWith, idIn } from '@/access/files'
import { adminOrStudentField, companyIdOf, isAdmin, isStudent, relationId } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  checkUpload,
  MB,
  privateUpload,
  setOriginalName,
  type UploadRule,
} from '@/lib/uploads/fileRules'
import { limitUnusedFiles } from '@/lib/uploads/unused'

export const CV_RULE: UploadRule = { kinds: ['pdf'], maxBytes: 10 * MB }

/** Admins, or the student who owns the CV. */
const ownerOrAdmin: Access = ({ req: { user } }) => {
  if (isAdmin(user)) return true
  return isStudent(user) ? { owner: { equals: user!.id } } : false
}

/**
 * A student's CV (PDF only, 10 MB). Private: served only through `/api/cvs/file/<name>`, which
 * applies the read rule below.
 *
 * Read: the student who owns it, admins, and a company only when Konnected selected the student
 * for one of the company's projects AND the student ticked "share my CV" (`privacy.shareCv`) AND
 * it is the CV on the student's profile. Write: the owner and admins.
 */
export const Cvs: CollectionConfig = {
  slug: 'cvs',
  labels: { singular: 'CV', plural: 'CVs' },
  graphQL: { singularName: 'Cv', pluralName: 'Cvs' },
  admin: { useAsTitle: 'originalName', defaultColumns: ['originalName', 'owner', 'createdAt'] },
  disableDuplicate: true,
  upload: privateUpload('cvs', CV_RULE),
  access: {
    read: async ({ req }) => {
      const { user } = req
      if (isAdmin(user)) return true
      if (isStudent(user)) return { owner: { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId ? idIn(await cvIdsSharedWith(req, companyId)) : false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ownerOrAdmin,
    delete: ownerOrAdmin,
  },
  hooks: {
    beforeOperation: [limitUnusedFiles('cvs'), checkUpload(CV_RULE)],
    beforeChange: [
      setOriginalName,
      ({ data, originalDoc, operation, req }) => {
        // The owner always comes from the session for a student, never from the request body.
        if (!isAdmin(req.user)) {
          data.owner = operation === 'create' ? req.user!.id : relationId(originalDoc?.owner)
        }
        if (!relationId(data.owner ?? originalDoc?.owner)) {
          throw new APIError('A CV needs an owner', 400)
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      // The student user the CV belongs to. Hidden from companies.
      name: 'owner',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      index: true,
      filterOptions: { role: { equals: 'student' } },
      access: { read: adminOrStudentField },
    },
    // The file name as uploaded, for display. Set by the server; the stored file has a random name.
    { name: 'originalName', type: 'text', admin: { readOnly: true } },
  ],
}
