import { type Access, APIError, type CollectionConfig, type Where } from 'payload'

import { idIn, releasedFileIdsForCompany, sentFileIdsForStudent } from '@/access/files'
import {
  adminOnlyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  checkUpload,
  MB,
  privateUpload,
  setOriginalName,
  type UploadRule,
} from '@/lib/uploads/fileRules'
import { limitUnusedFiles } from '@/lib/uploads/unused'

/** Owner decision 6 Nov 2026: PDF, Word, Excel, PowerPoint, PNG/JPG and zip, 50 MB a file. */
export const DELIVERABLE_FILE_RULE: UploadRule = {
  kinds: ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'zip'],
  maxBytes: 50 * MB,
}

/** At most this many files on one deliverable (owner decision 6 Nov 2026). */
export const MAX_DELIVERABLE_FILES = 10

/**
 * Admins, or the student a file's match belongs to while the file is not on a hand-in they sent:
 * Konnected checks a hand-in as it was sent, and the company receives it as it was released.
 */
const deleteAccess: Access = async ({ req }) => {
  const { user } = req
  if (isAdmin(user)) return true
  if (!isStudent(user)) return false
  const sent = await sentFileIdsForStudent(req, user!.id)
  const and: Where[] = [{ 'match.student.user': { equals: user!.id } }]
  if (sent.length) and.push({ id: { not_in: sent } })
  return { and }
}

/**
 * Files a student hands in for a match. A student uploads a file for one of their own matches,
 * then lists it on a deliverable (`deliverables.files`).
 *
 * Read: the matched student, admins, and the company of the project only after Konnected released
 * a deliverable that lists the file. Create: the matched student and admins. Change: admins only
 * (upload a new file instead). Delete: admins, and the student until the file is on a hand-in.
 */
export const DeliverableFiles: CollectionConfig = {
  slug: 'deliverable-files',
  admin: { useAsTitle: 'originalName', defaultColumns: ['originalName', 'match', 'createdAt'] },
  disableDuplicate: true,
  upload: privateUpload('deliverable-files', DELIVERABLE_FILE_RULE),
  access: {
    read: async ({ req }) => {
      const { user } = req
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'match.student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId ? idIn(await releasedFileIdsForCompany(req, companyId)) : false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: deleteAccess,
  },
  hooks: {
    beforeOperation: [limitUnusedFiles('deliverable-files'), checkUpload(DELIVERABLE_FILE_RULE)],
    beforeChange: [
      setOriginalName,
      async ({ data, originalDoc, operation, req }) => {
        if (operation === 'create') {
          const matchId = relationId(data.match)
          if (!matchId) throw new APIError('A deliverable file needs a match', 400)
          if (!isAdmin(req.user)) {
            // Bypass: the match is read only to check it belongs to this student.
            const match = await req.payload.findByID({
              collection: 'matches',
              id: matchId,
              depth: 1,
              overrideAccess: true,
              req,
            })
            const profile = typeof match.student === 'object' ? match.student : null
            if (!profile || relationId(profile.user) !== req.user!.id) {
              throw new APIError('This match is not yours', 403)
            }
          }
          data.uploadedBy = req.user?.id ?? null
        } else {
          data.uploadedBy = relationId(originalDoc?.uploadedBy) ?? null
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
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
    {
      // Who uploaded it (the student, or an admin on their behalf). Hidden from companies.
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
      access: { read: adminOrStudentField },
    },
    { name: 'originalName', type: 'text', admin: { readOnly: true } },
  ],
}
