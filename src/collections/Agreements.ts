import { APIError, type CollectionConfig } from 'payload'

import { agreementPartyWhere, isAgreementServerWrite } from '@/access/agreements'
import { adminOnlyField, adminOrStudentField, isAdmin } from '@/access/roles'
import { logActivityAfterChange } from '@/hooks/logActivity'
import {
  AGREEMENT_KINDS,
  AGREEMENT_STATUSES,
  type AgreementStatus,
  VOIDABLE,
} from '@/lib/agreements/fields'

/**
 * One agreement: the company agreement of a project (Konnected and the company), or the student
 * agreement of a match (Konnected and the student). Made from the published template of its kind,
 * filled with the project's values, converted to a PDF that every signer signs (its SHA-256 is
 * `unsignedSha256`), and, once Konnected has signed last, a signed PDF with a signing page.
 *
 * Read: admins, and the agreement's own party (agreementPartyWhere). A company never reads a
 * student agreement. Create and every change: only Konnected's agreement code (lib/agreements),
 * marked with the server-write context flag; no API call can write an agreement. The one change
 * the team makes through the API is to withdraw (void) an agreement that is not complete.
 *
 * A signed agreement never changes: not its PDFs, its hashes nor its signatures. Only the time the
 * email went out is recorded afterwards. The database refuses anything else too (migration
 * 20261106_220725_agreements), and nobody can delete an agreement.
 */
export const Agreements: CollectionConfig = {
  slug: 'agreements',
  admin: { useAsTitle: 'reference', defaultColumns: ['reference', 'kind', 'status', 'project'] },
  disableDuplicate: true,
  access: {
    read: ({ req: { user } }) => agreementPartyWhere(user),
    create: () => false,
    update: ({ req: { user } }) => isAdmin(user),
    delete: () => false,
  },
  hooks: {
    beforeChange: [
      ({ data, originalDoc, operation, req }) => {
        const server = isAgreementServerWrite(req)
        if (operation === 'create') {
          if (!server) throw new APIError('Agreements are made by Konnected from a template.', 403)
          return data
        }
        const from = originalDoc?.status as AgreementStatus
        if (from === 'signed') {
          // Complete: only the server records when the email went out, once.
          const keys = Object.keys(data).filter((k) => k !== 'updatedAt')
          const onlyEmailed = keys.every((k) =>
            k === 'emailedAt'
              ? !originalDoc?.emailedAt
              : JSON.stringify(data[k] ?? null) === JSON.stringify(originalDoc?.[k] ?? null),
          )
          if (!server || !onlyEmailed) {
            throw new APIError('A signed agreement cannot be changed.', 403)
          }
          return data
        }
        if (server) return data

        // Through the API: the team can only withdraw an agreement that is not complete. Every
        // other value stays as the server wrote it.
        if (!isAdmin(req.user)) throw new APIError('Agreements cannot be changed.', 403)
        if (data.status !== 'void' || !VOIDABLE.includes(from)) {
          throw new APIError('Only an unfinished agreement can be withdrawn.', 400)
        }
        // The stored values, not the request's: Payload writes what this hook returns.
        const { id: _id, createdAt: _c, updatedAt: _u, ...stored } = originalDoc ?? {}
        return { ...stored, status: 'void', voidedAt: new Date().toISOString(), activeKey: null }
      },
    ],
    beforeDelete: [
      () => {
        throw new APIError('Agreements are kept. Withdraw one instead.', 403)
      },
    ],
    afterChange: [logActivityAfterChange({ statusField: 'status' })],
  },
  fields: [
    {
      // A short reference printed on the PDF and in the emails, for example AGR-3F9A61C0.
      name: 'reference',
      type: 'text',
      required: true,
      unique: true,
      admin: { readOnly: true },
    },
    { name: 'kind', type: 'select', required: true, index: true, options: [...AGREEMENT_KINDS] },
    {
      // A copy of the project title when the agreement was made, for the parties' screens and
      // emails (a student cannot read a project once it is no longer published).
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'generating',
      index: true,
      options: [...AGREEMENT_STATUSES],
    },
    { name: 'project', type: 'relationship', relationTo: 'projects', required: true, index: true },
    {
      // Company agreements only. The company that signs.
      name: 'company',
      type: 'relationship',
      relationTo: 'companies',
      index: true,
    },
    {
      // Student agreements only. Hidden from companies (they never read these anyway).
      name: 'match',
      type: 'relationship',
      relationTo: 'matches',
      index: true,
      access: { read: adminOrStudentField },
    },
    {
      // Student agreements only: the student who signs.
      name: 'student',
      type: 'relationship',
      relationTo: 'student-profiles',
      index: true,
      access: { read: adminOrStudentField },
    },
    {
      name: 'template',
      type: 'relationship',
      relationTo: 'agreement-templates',
      access: { read: adminOnlyField },
    },
    // A copy of the template's version number, so a later upload never changes it.
    { name: 'templateVersion', type: 'number' },
    {
      // The values filled into the template. The PDF shows them to the parties.
      name: 'values',
      type: 'json',
      access: { read: adminOnlyField },
    },
    { name: 'unsignedPdf', type: 'upload', relationTo: 'agreement-pdfs' },
    { name: 'unsignedSha256', type: 'text' },
    { name: 'signedPdf', type: 'upload', relationTo: 'agreement-pdfs' },
    { name: 'signedSha256', type: 'text' },
    { name: 'generatedAt', type: 'date' },
    { name: 'partySignedAt', type: 'date' },
    { name: 'completedAt', type: 'date' },
    { name: 'emailedAt', type: 'date' },
    { name: 'voidedAt', type: 'date' },
    {
      // Why the PDF could not be made: a code for the team (no personal data).
      name: 'failure',
      type: 'text',
      access: { read: adminOnlyField },
    },
    {
      name: 'replaces',
      type: 'relationship',
      relationTo: 'agreements',
      access: { read: adminOnlyField },
    },
    {
      name: 'requestedBy',
      type: 'relationship',
      relationTo: 'users',
      access: { read: adminOnlyField },
    },
    {
      // `<kind>:<project or match id>` while the agreement is in use (not failed or withdrawn).
      // Unique, so a project never has two company agreements in use, even when the team asks
      // twice at the same moment.
      name: 'activeKey',
      type: 'text',
      unique: true,
      admin: { hidden: true },
      access: { read: adminOnlyField },
    },
  ],
}
