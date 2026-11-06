import { APIError, type CollectionConfig } from 'payload'

import { agreementPartyWhere, isAgreementServerWrite } from '@/access/agreements'
import { MB, privateUpload, type UploadRule } from '@/lib/uploads/fileRules'

/** The PDFs the converter and the signing page produce. Never uploaded by a person. */
export const AGREEMENT_PDF_RULE: UploadRule = { kinds: ['pdf'], maxBytes: 30 * MB }

/**
 * The PDFs of agreements: the filled one everyone signs (`unsigned`) and the final one with the
 * signing page (`signed`). Private files, served only through Payload's access-checked file route
 * as a download.
 *
 * Read: admins and the agreement's two parties (agreementPartyWhere through `agreement`). Create:
 * only the agreement code (server-write flag); closed to every API. Never changed or deleted (the
 * database refuses it too): the stored SHA-256 must always match the stored file.
 */
export const AgreementPdfs: CollectionConfig = {
  slug: 'agreement-pdfs',
  admin: { defaultColumns: ['agreement', 'variant', 'createdAt'] },
  disableDuplicate: true,
  upload: privateUpload('agreement-pdfs', AGREEMENT_PDF_RULE),
  access: {
    read: ({ req: { user } }) => agreementPartyWhere(user, 'agreement.'),
    create: () => false,
    update: () => false,
    delete: () => false,
  },
  hooks: {
    beforeChange: [
      ({ data, operation, req }) => {
        if (operation !== 'create' || !isAgreementServerWrite(req)) {
          throw new APIError('Agreement PDFs cannot be written or changed.', 403)
        }
        return data
      },
    ],
    beforeDelete: [
      () => {
        throw new APIError('Agreement PDFs are kept.', 403)
      },
    ],
  },
  fields: [
    {
      name: 'agreement',
      type: 'relationship',
      relationTo: 'agreements',
      required: true,
      index: true,
    },
    { name: 'variant', type: 'select', required: true, options: ['unsigned', 'signed'] },
    { name: 'sha256', type: 'text', required: true },
  ],
}
