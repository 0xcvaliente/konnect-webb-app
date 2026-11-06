import {
  APIError,
  type CollectionConfig,
  type PayloadRequest,
  type Validate,
  validations,
  type Where,
} from 'payload'

import {
  adminOnlyField,
  adminOrCompanyField,
  companyIdOf,
  isAdmin,
  isCompany,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import {
  COMPANY_STATUSES,
  isValidOrgNumber,
  LIMITS,
  normalizeOrgNumber,
  normalizeWebsite,
  SECTOR_KEYS,
} from '@/lib/companies/fields'
import {
  assertInitialStatus,
  assertTransition,
  COMPANY_TRANSITIONS,
  type CompanyStatus,
} from '@/lib/transitions'

/** Fields copied onto the company's projects. A change to either refreshes the copies. */
const COPIED_TO_PROJECTS = ['name', 'logo'] as const

/**
 * Fields a company can no longer change once Konnected approved it: Konnected checked them, and
 * students see the name on published projects. An admin can still change them.
 */
export const LOCKED_AFTER_APPROVAL = ['name', 'orgNumber'] as const

const isBlank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim())

/**
 * A field the onboarding asks for. A company user must fill it in; admins (and server code) may
 * leave it empty, for example for a pilot company Konnected adds by hand.
 */
const requiredForCompany =
  (base?: Validate): Validate =>
  async (value, options) => {
    const result = base ? await base(value, options) : true
    if (result !== true) return result
    if (isCompany(options.req.user) && isBlank(value)) return options.req.t('validation:required')
    return true
  }

const orgNumberRule: Validate = (value: unknown) =>
  isBlank(value) || (typeof value === 'string' && isValidOrgNumber(value))
    ? true
    : 'Use the nine digits of a valid organisation number.'

const websiteRule: Validate = (value: unknown) =>
  isBlank(value) || (typeof value === 'string' && normalizeWebsite(value) === value)
    ? true
    : 'Use a web address that starts with https:// or http://.'

/** Make the users list match `companies.user`: the new user points here, the old one does not. */
async function syncUserLink(
  req: PayloadRequest,
  companyId: number,
  from: number | undefined,
  to: number | undefined,
) {
  // Bypass: `users.company` is set only by the server (see Users), so it can always be checked
  // against `companies.user`. The unique index on `users.company` makes a second user impossible.
  if (from && from !== to) {
    const previous = await req.payload.findByID({
      collection: 'users',
      id: from,
      depth: 0,
      overrideAccess: true,
      disableErrors: true,
      req,
    })
    if (previous && relationId(previous.company) === companyId) {
      await req.payload.update({
        collection: 'users',
        id: from,
        data: { company: null },
        overrideAccess: true,
        req,
      })
    }
  }
  if (to && to !== from) {
    await req.payload.update({
      collection: 'users',
      id: to,
      data: { company: companyId },
      overrideAccess: true,
      req,
    })
  }
}

/**
 * Companies (startups). One company has exactly one user (a unique index on `companies.user` and
 * on `users.company`), and one user has at most one company.
 *
 * Read: admins all; a company user only their own company. Students never read companies: they
 * see the name and logo copied onto a published project. Nobody but admins lists companies.
 * Create: a company user without a company (it starts `pending`), and admins.
 * Update: admins; the company user their own company while it is pending or approved, and only
 * the fields they filled in at registration (name and organisation number only while pending).
 * Status, the linked user, the Konnected owner and the approval date are admin only.
 */
export const Companies: CollectionConfig = {
  slug: 'companies',
  admin: {
    useAsTitle: 'name',
    defaultColumns: ['name', 'orgNumber', 'status', 'teamOwner'],
  },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      return companyId ? { id: { equals: companyId } } : false
    },
    // A company user can create exactly one company, which starts as pending.
    create: ({ req: { user } }) => isAdmin(user) || (isCompany(user) && !companyIdOf(user)),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      // A rejected company cannot change anything; it writes to the team instead.
      return companyId
        ? { and: [{ id: { equals: companyId } }, { status: { in: ['pending', 'approved'] } }] }
        : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = req.user?.role
        const admin = isAdmin(req.user)

        if (operation === 'create') {
          assertInitialStatus<CompanyStatus>('pending', data.status, 'A new company')
          data.status = 'pending'
          // A company user registers their own company. The client cannot choose the user.
          if (isCompany(req.user)) data.user = req.user!.id
        } else {
          const from = originalDoc?.status as CompanyStatus
          const to = (data.status ?? from) as CompanyStatus
          assertTransition(COMPANY_TRANSITIONS, from, to, role, 'Company')

          // Name and organisation number are checked by Konnected: fixed once approved.
          if (!admin && from !== 'pending') {
            for (const key of LOCKED_AFTER_APPROVAL) {
              if (data[key] !== undefined && data[key] !== originalDoc?.[key]) {
                throw new APIError(`Company: ${key} cannot change after approval`, 403)
              }
            }
          }
        }

        // The approval date follows the status. Field access keeps it admin-only.
        const status = data.status ?? originalDoc?.status
        if (status === 'approved' && originalDoc?.status !== 'approved') {
          data.approvedAt ??= new Date().toISOString()
        } else if (status !== 'approved') {
          data.approvedAt = null
        }

        // Bypass for the checks below: the server reads the logo's uploader and the linked
        // users, which the acting user may not be allowed to read. Only ids and roles are used.
        // The logo must be one the company's own user uploaded. An admin may attach any logo.
        // For a company user the owner comes from the stored record (or the session on create),
        // never from the request: field access drops their `user` value only after this hook.
        const logoId = relationId(data.logo)
        if (logoId && logoId !== relationId(originalDoc?.logo)) {
          const logo = await req.payload.findByID({
            collection: 'company-logos',
            id: logoId,
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          const owner = relationId(
            admin || operation === 'create' ? (data.user ?? originalDoc?.user) : originalDoc?.user,
          )
          if (!logo || (!admin && relationId(logo.uploadedBy) !== owner)) {
            throw new APIError('This logo does not belong to this company', 403)
          }
        }

        // Admin changes only (field access drops these for everyone else): the linked user must
        // have the company role, and the Konnected owner must be on the team.
        if (admin) {
          const checkRole = async (id: number | undefined, wanted: 'company' | 'admin') => {
            if (!id) return
            const user = await req.payload.findByID({
              collection: 'users',
              id,
              depth: 0,
              overrideAccess: true,
              disableErrors: true,
              req,
            })
            if (user?.role !== wanted) {
              throw new APIError(`Company: that user is not a ${wanted} user`, 400)
            }
          }
          if (relationId(data.user) !== relationId(originalDoc?.user)) {
            await checkRole(relationId(data.user), 'company')
          }
          if (relationId(data.teamOwner) !== relationId(originalDoc?.teamOwner)) {
            await checkRole(relationId(data.teamOwner), 'admin')
          }
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req }) => {
        // Link the company's user to it (and unlink a user an admin replaced).
        const from = operation === 'create' ? undefined : relationId(previousDoc?.user)
        const to = relationId(doc.user)
        if (from !== to) await syncUserLink(req, doc.id, from, to)

        // Keep the name and logo copies on the company's projects in step. Bypass: the server
        // re-saves each project so its own hook copies them again; nothing else changes.
        if (operation === 'update') {
          const changed = COPIED_TO_PROJECTS.some(
            (key) =>
              JSON.stringify(relationId(doc[key]) ?? doc[key] ?? null) !==
              JSON.stringify(relationId(previousDoc?.[key]) ?? previousDoc?.[key] ?? null),
          )
          if (changed) {
            const projects = await req.payload.find({
              collection: 'projects',
              where: { company: { equals: doc.id } },
              depth: 0,
              pagination: false,
              select: { status: true },
              overrideAccess: true,
              req,
            })
            for (const project of projects.docs) {
              await req.payload.update({
                collection: 'projects',
                id: project.id,
                data: {},
                overrideAccess: true,
                req,
              })
            }
          }
        }
        return doc
      },
      logActivityAfterChange({ statusField: 'status' }),
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      maxLength: LIMITS.name,
      hooks: {
        beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
      },
    },
    {
      // Nine digits with a valid check digit. The Brønnøysund lookup comes with a later card.
      name: 'orgNumber',
      label: 'Organisation number',
      type: 'text',
      index: true,
      hooks: {
        beforeValidate: [
          ({ value }) => (typeof value === 'string' ? normalizeOrgNumber(value.trim()) : value),
        ],
      },
      validate: requiredForCompany(orgNumberRule),
    },
    {
      // The person who registered the company and Konnected's contact there.
      name: 'contactName',
      type: 'text',
      maxLength: LIMITS.contactName,
      validate: requiredForCompany(validations.text as Validate),
    },
    {
      name: 'contactRole',
      label: 'Contact role',
      type: 'text',
      maxLength: LIMITS.contactRole,
      validate: requiredForCompany(validations.text as Validate),
    },
    {
      name: 'website',
      type: 'text',
      maxLength: LIMITS.website,
      hooks: {
        beforeValidate: [
          ({ value }) =>
            typeof value === 'string'
              ? value.trim()
                ? (normalizeWebsite(value) ?? value)
                : null
              : value,
        ],
      },
      validate: (async (value, options) => {
        const base = await (validations.text as Validate)(value, options)
        return base === true ? websiteRule(value, options) : base
      }) satisfies Validate,
    },
    {
      name: 'sector',
      type: 'select',
      options: [...SECTOR_KEYS],
      validate: requiredForCompany(validations.select as Validate),
    },
    {
      name: 'description',
      type: 'textarea',
      maxLength: LIMITS.description,
      validate: requiredForCompany(validations.textarea as Validate),
    },
    {
      // Optional. PNG or JPG, 1 MB (see `company-logos`).
      name: 'logo',
      type: 'upload',
      relationTo: 'company-logos',
      // Admin panel helper only. The hook above is the real check.
      filterOptions: ({ data }) => ({ uploadedBy: { equals: relationId(data?.user) ?? 0 } }),
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'pending',
      index: true,
      options: [...COMPANY_STATUSES],
      // Only the Konnected team approves or rejects a company.
      access: { create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // The one company user. Set by the server when a company user registers; an admin can
      // change it in the admin panel, and the users list follows (see syncUserLink).
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      unique: true,
      index: true,
      filterOptions: { role: { equals: 'company' } },
      access: { read: adminOrCompanyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // The person on the Konnected team who follows this company (team split by company).
      name: 'teamOwner',
      label: 'Konnected owner',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      filterOptions: { role: { equals: 'admin' } },
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // When Konnected approved the company. Set by the hook above; an admin may correct it.
      name: 'approvedAt',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
  ],
}
