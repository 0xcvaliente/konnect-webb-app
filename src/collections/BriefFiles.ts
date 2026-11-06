import { type Access, APIError, type CollectionConfig, type Where } from 'payload'

import { briefIdsForStudent, idIn, lockedBriefIdsForCompany } from '@/access/files'
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
  checkUpload,
  MB,
  privateUpload,
  setOriginalName,
  type UploadRule,
} from '@/lib/uploads/fileRules'
import { limitUnusedFiles } from '@/lib/uploads/unused'

/** Company brief attachments: PDF, Word, Excel, PowerPoint and images (PNG/JPG), 20 MB. */
export const BRIEF_FILE_RULE: UploadRule = {
  kinds: ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg'],
  maxBytes: 20 * MB,
}

/** At most this many attachments on one project. */
export const MAX_BRIEF_FILES = 10

/**
 * Admins, or the owning company while the file is not on a project Konnected has started to
 * review (only `draft` and `changes_requested` projects can still change).
 */
const deleteAccess: Access = async ({ req }) => {
  const { user } = req
  if (isAdmin(user)) return true
  const companyId = companyIdOf(user)
  if (!companyId) return false
  const locked = await lockedBriefIdsForCompany(req, companyId)
  const and: Where[] = [{ company: { equals: companyId } }]
  if (locked.length) and.push({ id: { not_in: locked } })
  return { and }
}

/**
 * Files a company attaches to a project brief (`projects.attachments`).
 *
 * Read: the owning company, admins, and only the student Konnected selected for a project that
 * lists the file. Other students never get them, even on a published project. Create: a company
 * user for its own company, and admins. Change: admins only. Delete: see `deleteAccess`.
 */
export const BriefFiles: CollectionConfig = {
  slug: 'brief-files',
  admin: { useAsTitle: 'originalName', defaultColumns: ['originalName', 'company', 'createdAt'] },
  disableDuplicate: true,
  upload: privateUpload('brief-files', BRIEF_FILE_RULE),
  access: {
    read: async ({ req }) => {
      const { user } = req
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      if (companyId) return { company: { equals: companyId } }
      if (isStudent(user)) return idIn(await briefIdsForStudent(req, user!.id))
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || Boolean(companyIdOf(user)),
    update: ({ req: { user } }) => isAdmin(user),
    delete: deleteAccess,
  },
  hooks: {
    beforeOperation: [limitUnusedFiles('brief-files'), checkUpload(BRIEF_FILE_RULE)],
    beforeChange: [
      setOriginalName,
      ({ data, originalDoc, operation, req }) => {
        // A company user can only upload for their own company. The client cannot choose it.
        if (operation === 'create' && isCompany(req.user)) data.company = companyIdOf(req.user)
        if (!relationId(data.company ?? originalDoc?.company)) {
          throw new APIError('A brief file needs a company', 400)
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
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
    { name: 'originalName', type: 'text', admin: { readOnly: true } },
  ],
}
