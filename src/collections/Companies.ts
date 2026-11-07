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
  effectiveRole,
  isAdmin,
  isCompany,
  relationId,
} from '@/access/roles'
import { isOnTeam, refuseTakenOnPoolTake } from '@/access/team'
import { copyNameToUser } from '@/hooks/copyNameToUser'
import {
  logActivityAfterChange,
  logActivityAfterDelete,
  logReassignments,
  writeActivity,
} from '@/hooks/logActivity'
import { sendCompanyReviewEmail } from '@/lib/email/companyEmails'
import {
  BILLING_FIELDS,
  BILLING_LIMITS,
  COMPANY_STATUSES,
  isEmailAddress,
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
 * leave it empty, for example for a pilot company Konnected adds by hand. A field locked after
 * approval (`untilApproved`) is required only while the company is new or pending: once approved
 * the company cannot change it, so a blank one Konnected left must not block every later save.
 * `data.status` is the stored status here: the collection hook refuses a company's own change.
 */
const requiredForCompany =
  (base?: Validate, { untilApproved = false } = {}): Validate =>
  async (value, options) => {
    const result = base ? await base(value, options) : true
    if (result !== true) return result
    if (!isCompany(options.req.user) || !isBlank(value)) return true
    const status = (options.data as { status?: unknown } | undefined)?.status
    if (untilApproved && options.operation !== 'create' && status !== 'pending') return true
    return options.req.t('validation:required')
  }

/**
 * Payload checks a relationship's `filterOptions` again on every save, against the whole stored
 * document and with the acting user's read access. For `logo` and `teamOwner` that refuses saves
 * that are fine (a company cannot read its admin owner; an admin hands a company with a logo to
 * a new user), so only the base checks run. The collection hook is the real rule for both;
 * `filterOptions` stays as a picker helper in the admin panel.
 */
const withoutFilterOptions =
  (base: Validate): Validate =>
  (value, options) =>
    base(value, { ...options, filterOptions: undefined } as typeof options)

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
 * Update: admins; the company user their own company while it is pending or approved, or once
 * after a rejection (that save sends it back to review), and only the fields they filled in at
 * registration (name and organisation number not once approved). Status, the linked user, the
 * Konnected owner, the approval date and the review fields (note, more information asked, review
 * clock, sent again) are written by admins or by the hook only.
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
      // A rejected company may correct its details and send them again once (owner decision);
      // after that it cannot change anything and writes to the team instead.
      return companyId
        ? {
            and: [
              { id: { equals: companyId } },
              {
                or: [
                  { status: { in: ['pending', 'approved'] } },
                  {
                    and: [{ status: { equals: 'rejected' } }, { resentAt: { exists: false } }],
                  },
                ],
              },
            ],
          }
        : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      refuseTakenOnPoolTake('companies'),
      async ({ data, originalDoc, operation, req }) => {
        const role = effectiveRole(req.user)
        const admin = isAdmin(req.user)

        const now = new Date().toISOString()
        if (operation === 'create') {
          assertInitialStatus<CompanyStatus>('pending', data.status, 'A new company')
          data.status = 'pending'
          // The review clock starts now (the team's queue shows how long it has waited).
          data.reviewRequestedAt = now
          // A company user registers their own company. The client cannot choose the user.
          if (isCompany(req.user)) data.user = req.user!.id
        } else {
          const from = originalDoc?.status as CompanyStatus
          // A save that changes only the billing details is not an answer to Konnected's review:
          // it leaves the review state alone (no resend, no answer to a request for information).
          const changed = Object.keys(data).filter(
            (key) =>
              JSON.stringify(relationId(data[key]) ?? data[key] ?? null) !==
              JSON.stringify(relationId(originalDoc?.[key]) ?? originalDoc?.[key] ?? null),
          )
          const billingOnly =
            changed.length > 0 &&
            changed.every((key) => (BILLING_FIELDS as readonly string[]).includes(key))
          if (!admin && billingOnly && from === 'rejected') {
            throw new APIError('Company: billing details wait until Konnected approves', 403)
          }
          if (!admin && from === 'rejected') {
            // The company's own save after a rejection is its one correction: it goes back to
            // Konnected. Access already refuses a second one; this is the second layer.
            if (originalDoc?.resentAt) {
              throw new APIError('Company: already sent again once', 403)
            }
            data.status = 'pending'
            data.resentAt = now
            data.reviewRequestedAt = now
          }
          const to = (data.status ?? from) as CompanyStatus
          assertTransition(COMPANY_TRANSITIONS, from, to, role, 'Company')

          // Konnected asked for more information: the company's next save is its answer, and the
          // company is back in the team's queue.
          if (!admin && !billingOnly && originalDoc?.infoRequestedAt) {
            data.infoRequestedAt = null
            data.reviewRequestedAt = now
          }

          // Name and organisation number are checked by Konnected: fixed once approved.
          if (!admin && from === 'approved') {
            for (const key of LOCKED_AFTER_APPROVAL) {
              if (data[key] !== undefined && data[key] !== originalDoc?.[key]) {
                throw new APIError(`Company: ${key} cannot change after approval`, 403)
              }
            }
          }
        }

        if (admin && operation === 'update') {
          // Asking for more information keeps the company pending; it only makes sense then.
          if (data.infoRequestedAt && !originalDoc?.infoRequestedAt) {
            if ((data.status ?? originalDoc?.status) !== 'pending') {
              throw new APIError('Company: ask for more information only while pending', 400)
            }
          }
          // A decision ends any open request for more information.
          if (data.status !== originalDoc?.status) data.infoRequestedAt = null
          // The date of Konnected's latest note follows the note.
          if ((data.noteToCompany ?? '') !== (originalDoc?.noteToCompany ?? '')) {
            data.noteToCompanyAt = data.noteToCompany ? now : null
          }
          // One company account per organisation number (owner decision): the team cannot approve
          // a second company with a number another approved company already has. Bypass: the
          // server compares numbers across companies; only ids are read.
          const orgNumber = data.orgNumber ?? originalDoc?.orgNumber
          if (data.status === 'approved' && originalDoc?.status !== 'approved' && orgNumber) {
            const same = await req.payload.count({
              collection: 'companies',
              where: {
                and: [
                  { orgNumber: { equals: orgNumber } },
                  { status: { equals: 'approved' } },
                  { id: { not_equals: originalDoc?.id } },
                ],
              },
              overrideAccess: true,
              req,
            })
            if (same.totalDocs > 0) {
              throw new APIError('Company: another approved company has this number', 409)
            }
          }
        }

        // The approval date follows the status. Field access keeps it admin-only.
        const status = data.status ?? originalDoc?.status
        if (status === 'approved' && originalDoc?.status !== 'approved') {
          data.approvedAt ??= new Date().toISOString()
          // Whoever took the company from the shared pool, or else whoever approves it, becomes
          // its owner on the team, unless the team already chose one (team split by company).
          // Someone who has left the team is skipped.
          const chosen = relationId(data.teamOwner ?? originalDoc?.teamOwner)
          if (admin && !(await isOnTeam(req, chosen))) {
            const taker = relationId(data.takenBy ?? originalDoc?.takenBy)
            data.teamOwner = (await isOnTeam(req, taker)) ? taker : req.user!.id
          }
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
          const checkRole = async (id: number | undefined, wanted: 'company') => {
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
          // A newly chosen owner or taker must be on the team (admin, on ADMIN_EMAILS, not paused).
          for (const key of ['teamOwner', 'takenBy'] as const) {
            const id = relationId(data[key])
            if (id && id !== relationId(originalDoc?.[key]) && !(await isOnTeam(req, id))) {
              throw new APIError(`Company: the ${key} must be on the team`, 400)
            }
          }
        }
        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, operation, req, context }) => {
        if (operation !== 'update') return doc
        // Asking for more information and the company's answer are not status changes, so they
        // get their own activity rows. The team's note goes with the request.
        if (!context?.skipActivityLog) {
          if (doc.infoRequestedAt && !previousDoc?.infoRequestedAt) {
            await writeActivity(req, {
              action: 'info_requested',
              targetCollection: 'companies',
              targetId: String(doc.id),
              note: doc.noteToCompany?.slice(0, 2000) || undefined,
            })
          } else if (
            !doc.infoRequestedAt &&
            previousDoc?.infoRequestedAt &&
            doc.status === previousDoc?.status
          ) {
            await writeActivity(req, {
              action: 'info_answered',
              targetCollection: 'companies',
              targetId: String(doc.id),
            })
          }
        }
        // Tell the company what Konnected decided, in its user's language.
        if (doc.status !== previousDoc?.status && doc.status !== 'pending') {
          await sendCompanyReviewEmail(req, doc, doc.status)
        } else if (doc.infoRequestedAt && !previousDoc?.infoRequestedAt) {
          await sendCompanyReviewEmail(req, doc, 'info_requested')
        }
        return doc
      },
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
      logReassignments(['teamOwner', 'takenBy']),
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, previousDoc, operation, req, context }) => {
        // A change to the billing details goes to the activity log, by field name only (the
        // values are the company's contact details and stay out of the log).
        if (operation !== 'update' || context?.skipActivityLog) return doc
        for (const field of BILLING_FIELDS) {
          if ((doc[field] ?? null) === (previousDoc?.[field] ?? null)) continue
          // A company's own read of the previous document has every billing field, so the
          // comparison holds for both the company and the team.
          await writeActivity(req, {
            action: 'review_change',
            targetCollection: 'companies',
            targetId: String(doc.id),
            field,
          })
        }
        return doc
      },
      async ({ doc, previousDoc, operation, req }) => {
        // Projects follow their company's owner: when the owner changes, every open project that
        // followed the old owner (or had none) moves to the new one, in the same transaction and
        // with the same note. A project the team moved to someone else on its own page stays.
        // Bypass: the server re-saves the projects as part of the team's change; each move goes
        // through the Projects hook and is logged there.
        if (operation !== 'update' || !isAdmin(req.user)) return doc
        const before = relationId(previousDoc?.teamOwner)
        const after = relationId(doc.teamOwner)
        if (!after || before === after) return doc
        const followers = await req.payload.find({
          collection: 'projects',
          where: {
            and: [
              { company: { equals: doc.id } },
              { status: { not_in: ['closed', 'rejected'] } },
              before
                ? { or: [{ owner: { equals: before } }, { owner: { exists: false } }] }
                : { owner: { exists: false } },
            ],
          },
          depth: 0,
          pagination: false,
          select: { owner: true },
          overrideAccess: true,
          req,
        })
        for (const project of followers.docs) {
          await req.payload.update({
            collection: 'projects',
            id: project.id,
            data: { owner: after },
            overrideAccess: true,
            req,
          })
        }
        return doc
      },
      copyNameToUser('contactName'),
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
      validate: requiredForCompany(orgNumberRule, { untilApproved: true }),
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
      // Admin panel picker only (see withoutFilterOptions). The hook above is the real check, and
      // an admin may attach any logo.
      filterOptions: ({ data, req }) =>
        isAdmin(req.user) ? true : { uploadedBy: { equals: relationId(data?.user) ?? 0 } },
      validate: withoutFilterOptions(validations.upload as Validate),
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
      // Admin panel picker only (see withoutFilterOptions); the hook above checks the role.
      filterOptions: { role: { equals: 'admin' } },
      validate: withoutFilterOptions(validations.relationship as Validate),
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // Who on the team took this new company from the shared pool to review it. Set by the
      // team ("Take it"); the person who takes it becomes the owner at approval unless the team
      // chose one. Team only.
      name: 'takenBy',
      label: 'Taken from the pool by',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      filterOptions: { role: { equals: 'admin' } },
      validate: withoutFilterOptions(validations.relationship as Validate),
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // Konnected's latest note to the company: the reason for a rejection, or what to add or
      // correct. Written by the team at review; the company reads it on its status and profile.
      name: 'noteToCompany',
      label: 'Latest note to the company',
      type: 'textarea',
      maxLength: 2000,
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'noteToCompanyAt',
      label: 'Note written',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // Set when Konnected asks for more information (the company stays pending); cleared by the
      // company's next save of its details, or by a decision. Server rules in the hook above.
      name: 'infoRequestedAt',
      label: 'More information asked',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // When the company last came to Konnected for review: registration, its answer to a
      // request for more information, or its one correction after a rejection. Set by the server.
      name: 'reviewRequestedAt',
      label: 'Waiting for review since',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // When a rejected company corrected its details and sent them again. A company may do that
      // once (owner decision). Set by the server.
      name: 'resentAt',
      label: 'Sent again after rejection',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // When Konnected approved the company. Set by the hook above; an admin may correct it.
      name: 'approvedAt',
      type: 'date',
      access: { read: adminOrCompanyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // Billing (Kanban card "Billing details for invoices"): where Konnected sends invoices. The
      // company and the team edit it; the team reads it in the payment log. Optional: Konnected
      // falls back to the contact when it is empty.
      name: 'invoiceEmail',
      label: 'Invoice email',
      type: 'text',
      maxLength: BILLING_LIMITS.invoiceEmail,
      access: { read: adminOrCompanyField },
      hooks: {
        beforeValidate: [
          ({ value }) =>
            typeof value === 'string' ? value.trim().toLowerCase() || null : (value ?? undefined),
        ],
      },
      validate: ((value: unknown) =>
        isBlank(value) || (typeof value === 'string' && isEmailAddress(value))
          ? true
          : 'Use an email address.') satisfies Validate,
    },
    {
      // The reference or order number the company wants on every invoice.
      name: 'invoiceReference',
      label: 'Invoice reference',
      type: 'text',
      maxLength: BILLING_LIMITS.invoiceReference,
      access: { read: adminOrCompanyField },
      hooks: {
        beforeValidate: [
          ({ value }) => (typeof value === 'string' ? value.trim() || null : (value ?? undefined)),
        ],
      },
    },
    {
      // The company takes e-invoices (EHF): Konnected sends the invoice through EHF.
      name: 'ehfInvoice',
      label: 'Takes e-invoices (EHF)',
      type: 'checkbox',
      defaultValue: false,
      access: { read: adminOrCompanyField },
    },
  ],
}
