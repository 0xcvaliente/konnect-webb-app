import { type Access, APIError, type CollectionConfig, type Where } from 'payload'

import { idIn, logoIdsForStudents, logoIdsInUse, ownCompanyLogoId } from '@/access/files'
import { adminOrCompanyField, companyIdOf, isAdmin, isCompany, isStudent } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { LOGO_MAX_BYTES } from '@/lib/companies/fields'
import {
  checkUpload,
  privateUpload,
  setOriginalName,
  type UploadRule,
} from '@/lib/uploads/fileRules'
import { limitUnusedFiles } from '@/lib/uploads/unused'

/** A company logo: PNG or JPG, 1 MB at most. No SVG: it can carry scripts. */
export const LOGO_RULE: UploadRule = { kinds: ['png', 'jpg'], maxBytes: LOGO_MAX_BYTES }

/**
 * Admins, or the company user who uploaded the logo while nothing uses it (not on their company
 * and not on a project), so a logo students can see never disappears under them.
 */
const deleteAccess: Access = async ({ req }) => {
  const { user } = req
  if (isAdmin(user)) return true
  if (!isCompany(user)) return false
  const inUse = await logoIdsInUse(req)
  const and: Where[] = [{ uploadedBy: { equals: user!.id } }]
  if (inUse.length) and.push({ id: { not_in: inUse } })
  return { and }
}

/**
 * Company logos (optional, on the company profile). Private like every upload: served only
 * through `/api/company-logos/file/<name>`, which applies the read rule below.
 *
 * Read: admins; the company user who uploaded it and the company whose logo it is; students only
 * the logos of companies with a published project (students never read the company itself, they
 * get the name and logo copied onto the project). Create: company users and admins. Change:
 * admins only. Delete: see `deleteAccess`.
 */
export const CompanyLogos: CollectionConfig = {
  slug: 'company-logos',
  labels: { singular: 'Company logo', plural: 'Company logos' },
  admin: { useAsTitle: 'originalName', defaultColumns: ['originalName', 'createdAt'] },
  disableDuplicate: true,
  upload: privateUpload('company-logos', LOGO_RULE),
  access: {
    read: async ({ req }) => {
      const { user } = req
      if (isAdmin(user)) return true
      if (isCompany(user)) {
        const own = await ownCompanyLogoId(req, companyIdOf(user))
        const or: Where[] = [{ uploadedBy: { equals: user!.id } }]
        if (own) or.push({ id: { equals: own } })
        return { or }
      }
      if (isStudent(user)) return idIn(await logoIdsForStudents(req))
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isCompany(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: deleteAccess,
  },
  hooks: {
    beforeOperation: [limitUnusedFiles('company-logos'), checkUpload(LOGO_RULE)],
    beforeChange: [
      setOriginalName,
      ({ data, originalDoc, operation, req }) => {
        // The uploader always comes from the session, never from the request body.
        if (operation === 'create') data.uploadedBy = req.user?.id ?? null
        else data.uploadedBy = originalDoc?.uploadedBy ?? null
        if (!data.uploadedBy) throw new APIError('A logo needs an uploader', 400)
        return data
      },
    ],
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      // The account that uploaded the logo. Never shown to students.
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      admin: { readOnly: true },
      access: { read: adminOrCompanyField },
    },
    // The file name as uploaded, for display. Set by the server; the stored file has a random name.
    { name: 'originalName', type: 'text', admin: { readOnly: true } },
  ],
}
