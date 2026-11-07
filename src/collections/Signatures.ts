import { APIError, type CollectionConfig } from 'payload'

import { agreementPartyWhere, isAgreementServerWrite } from '@/access/agreements'
import { adminOnlyField } from '@/access/roles'
import { logActivityAfterChange } from '@/hooks/logActivity'
import { SIGN_IN_METHODS, SIGNATURE_PARTIES } from '@/lib/agreements/fields'

/**
 * One signature on one agreement: who signed (the user, kept from companies and students), for
 * which party, the typed name, the tick and the version of its text, the server time, the SHA-256
 * of the PDF the signer saw, and how they had signed in.
 *
 * Written only by the signing code (lib/agreements/sign.ts) with the server-write flag; closed to
 * every API. Never changed or deleted, by anyone (the database refuses it too). One signature per
 * party and agreement (unique index), so two clicks or two tabs cannot sign twice.
 *
 * Read: admins, and the parties of the agreement (agreementPartyWhere through `agreement`).
 */
export const Signatures: CollectionConfig = {
  slug: 'signatures',
  admin: { defaultColumns: ['agreement', 'party', 'typedName', 'signedAt'] },
  disableDuplicate: true,
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
          throw new APIError('Signatures cannot be written or changed.', 403)
        }
        return data
      },
    ],
    beforeDelete: [
      () => {
        throw new APIError('Signatures are kept.', 403)
      },
    ],
    afterChange: [logActivityAfterChange()],
  },
  indexes: [{ fields: ['agreement', 'party'], unique: true }],
  fields: [
    {
      name: 'agreement',
      type: 'relationship',
      relationTo: 'agreements',
      required: true,
      index: true,
    },
    {
      // The account that signed. Admins only; the parties see the typed name.
      name: 'signer',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      access: { read: adminOnlyField },
    },
    { name: 'party', type: 'select', required: true, options: [...SIGNATURE_PARTIES] },
    { name: 'typedName', type: 'text', required: true },
    { name: 'ticked', type: 'checkbox', required: true },
    { name: 'tickTextVersion', type: 'text', required: true },
    { name: 'documentSha256', type: 'text', required: true },
    { name: 'signedAt', type: 'date', required: true },
    { name: 'signInMethod', type: 'select', required: true, options: [...SIGN_IN_METHODS] },
  ],
}
