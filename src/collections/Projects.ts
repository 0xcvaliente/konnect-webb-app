import {
  APIError,
  type CollectionConfig,
  type Validate,
  ValidationError,
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
  isStudent,
  relationId,
} from '@/access/roles'
import { draftingCompanyId } from '@/access/companies'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { sendProjectSubmittedEmail } from '@/lib/email/projectEmails'
import {
  COMPANY_EDITABLE,
  DURATION_WEEKS,
  LIMITS,
  PAY_CHOICES,
  problemsForReview,
  type ReviewInput,
  WORK_MODES,
} from '@/lib/projects/fields'
import { MAX_BRIEF_FILES } from './BriefFiles'
import {
  assertInitialStatus,
  assertTransition,
  PROJECT_TRANSITIONS,
  type ProjectStatus,
} from '@/lib/transitions'

export const PROJECT_STATUSES: ProjectStatus[] = [
  'draft',
  'submitted',
  'changes_requested',
  'rejected',
  'approved',
  'published',
  'matched',
  'in_progress',
  'delivered',
  'closed',
]

/**
 * Konnected writes these; the company reads them on its own projects; students never read them
 * (the price and Konnected's note to the company).
 */
const teamWritesCompanyReads = {
  read: adminOrCompanyField,
  create: adminOnlyField,
  update: adminOnlyField,
}

/** Old free-text fields, replaced by numbers. Kept (hidden, admin only) until a later migration. */
const retired = {
  access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
  admin: { hidden: true },
}

const durationRule: Validate = (value: unknown) =>
  value === null ||
  value === undefined ||
  (DURATION_WEEKS as readonly number[]).includes(value as number)
    ? true
    : 'Pick one of the offered timeframes.'

const wholeNumber: Validate = (value: unknown) =>
  value === null || value === undefined || Number.isInteger(value)
    ? true
    : 'Use a whole number of hours.'

/** Payload's own number check first, then ours. */
const numberAnd =
  (extra: Validate): Validate =>
  async (value, options) => {
    const first = await (validations.number as Validate)(value, options)
    return first === true ? extra(value, options) : first
  }

/**
 * Projects a company submits for Konnected to review.
 *
 * Read: admins all; students only `published` projects (never the price or Konnected's note); a
 * company only its own. Create: admins, and a pending or approved company (a draft; owner
 * decision). Update: admins; the company its own project while it is a draft or changes were
 * requested, and only while the company is pending or approved. Sending for review needs an
 * approved company and, for a company, a complete project (checked in the hook, for every API).
 * The price and Konnected's note to the company are written by admins only.
 */
export const Projects: CollectionConfig = {
  slug: 'projects',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'companyName', 'status'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      // Students see only published projects.
      if (isStudent(user)) return { status: { equals: 'published' } }
      const companyId = companyIdOf(user)
      return companyId ? { company: { equals: companyId } } : false
    },
    // A pending or approved company writes drafts (owner decision); only an approved company
    // sends one for review (hook below). Admins always can.
    create: async ({ req }) => isAdmin(req.user) || Boolean(await draftingCompanyId(req)),
    update: async ({ req }): Promise<Where | boolean> => {
      if (isAdmin(req.user)) return true
      // A company edits its own project only while it is a draft or needs changes, and only
      // while Konnected has not rejected the company.
      const companyId = await draftingCompanyId(req)
      return companyId
        ? {
            and: [{ company: { equals: companyId } }, { status: { in: [...COMPANY_EDITABLE] } }],
          }
        : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = effectiveRole(req.user)

        if (operation === 'create') {
          assertInitialStatus<ProjectStatus>('draft', data.status, 'A new project')
          data.status = 'draft'
          // A company user can only create projects for their own company.
          if (isCompany(req.user)) data.company = companyIdOf(req.user)
        }

        const from = (originalDoc?.status ?? 'draft') as ProjectStatus
        const to = (data.status ?? from) as ProjectStatus
        if (operation === 'update') {
          assertTransition(PROJECT_TRANSITIONS, from, to, role, 'Project')
        }

        const companyId = relationId(data.company ?? originalDoc?.company)
        if (!companyId) throw new APIError('A project needs a company', 400)

        // Bypass: read the company with overrideAccess because students (who read projects) and
        // the acting user may not be allowed to read the company. Only name and status are used.
        const company = await req.payload.findByID({
          collection: 'companies',
          id: companyId,
          depth: 0,
          overrideAccess: true,
          req,
        })

        const sending = to === 'submitted' && from !== 'submitted'
        // A company that is not approved cannot send a project for review (a pending company
        // may keep drafts).
        if (sending && company.status !== 'approved') {
          throw new APIError('Only an approved company can send a project for review', 403)
        }

        // A company sends a project only when everything the review needs is filled in. Admins
        // (a pilot project Konnected types in by hand) are not held to the form.
        if (sending && isCompany(req.user)) {
          const merged = { ...(originalDoc ?? {}), ...data } as ReviewInput
          const problems = problemsForReview(merged)
          const errors = Object.entries(problems).map(([path, message]) => ({ path, message }))
          if (errors.length) throw new ValidationError({ collection: 'projects', errors, req })
        }

        // Every attachment must be a brief file of this project's company. Bypass: the server
        // reads the files' company, whatever the acting user may read.
        const attachmentIds = (data.attachments ?? []).map(relationId).filter(Boolean) as number[]
        if (attachmentIds.length) {
          const files = await req.payload.find({
            collection: 'brief-files',
            where: { id: { in: attachmentIds } },
            depth: 0,
            pagination: false,
            overrideAccess: true,
            req,
          })
          const ok = new Set(
            files.docs.filter((f) => relationId(f.company) === companyId).map((f) => f.id),
          )
          if (attachmentIds.some((id) => !ok.has(id))) {
            throw new APIError('An attachment does not belong to this company', 403)
          }
        }

        // The date of Konnected's latest note follows the note. Only admins write either (field
        // access drops a company's value).
        if (
          isAdmin(req.user) &&
          data.noteToCompany !== undefined &&
          (data.noteToCompany ?? '') !== (originalDoc?.noteToCompany ?? '')
        ) {
          data.noteToCompanyAt = data.noteToCompany ? new Date().toISOString() : null
        }

        // Students never read the company record. They see these copies of the name and logo.
        data.companyName = company.name
        data.companyLogo = relationId(company.logo) ?? null
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, previousDoc, operation, req }) => {
        // Confirm to the company that its project reached Konnected, every time it is sent
        // (also after changes). Sent after the response, so a slow mail server never fails it.
        if (
          operation === 'update' &&
          doc.status === 'submitted' &&
          previousDoc?.status !== 'submitted'
        ) {
          await sendProjectSubmittedEmail(req, doc)
        }
        return doc
      },
    ],
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
    {
      // Copy of the company name, set by the server, so students need no access to companies.
      // The beforeChange hook overwrites it on every save, so a client value never sticks. No
      // field-level access here: that is applied after the hook and would drop the server's value.
      name: 'companyName',
      type: 'text',
      admin: { readOnly: true },
    },
    {
      // Copy of the company logo, set by the server like `companyName`. Students may open the
      // logo file of a published project (see `company-logos`).
      name: 'companyLogo',
      type: 'upload',
      relationTo: 'company-logos',
      admin: { readOnly: true },
    },
    { name: 'title', type: 'text', required: true, maxLength: LIMITS.title },
    // Not required in the database: a draft may be saved before it is complete. Sending for
    // review checks every field the review needs (hook above).
    { name: 'description', type: 'textarea', maxLength: LIMITS.description },
    { name: 'tasks', type: 'textarea', maxLength: LIMITS.tasks },
    { name: 'deliverable', type: 'textarea', maxLength: LIMITS.deliverable },
    {
      name: 'desiredSkills',
      type: 'text',
      hasMany: true,
      maxRows: LIMITS.skills,
      maxLength: LIMITS.skill,
    },
    {
      name: 'workloadHours',
      label: 'Workload (hours)',
      type: 'number',
      min: LIMITS.hoursMin,
      max: LIMITS.hoursMax,
      validate: numberAnd(wholeNumber),
    },
    {
      name: 'durationWeeks',
      label: 'Timeframe (weeks)',
      type: 'number',
      validate: numberAnd(durationRule),
    },
    { name: 'startDate', label: 'Earliest start', type: 'date' },
    { name: 'workMode', label: 'Where the work is done', type: 'select', options: [...WORK_MODES] },
    // The place, when the work is not remote.
    { name: 'location', type: 'text', maxLength: LIMITS.location },
    {
      // The company's choice; Konnected makes the final decision at review and may change it.
      name: 'paidOrUnpaid',
      label: 'Paid or unpaid',
      type: 'select',
      options: [...PAY_CHOICES],
    },
    {
      // For an unpaid project: what the student gets instead. Students see it before they apply.
      name: 'unpaidBenefit',
      label: 'What the student gets (unpaid)',
      type: 'textarea',
      maxLength: LIMITS.unpaidBenefit,
    },
    {
      // The fixed price excluding VAT, set by Konnected at review (25 % VAT is added on the
      // invoice). Only admins write it; the company reads it on its own projects; students never
      // read it. The company form has no price input.
      name: 'fee',
      label: 'Price (NOK, excl. VAT)',
      type: 'number',
      min: 0,
      access: teamWritesCompanyReads,
    },
    // Applications close on this day. Konnected may change it at review.
    { name: 'deadline', label: 'Applications close', type: 'date' },
    {
      // Brief attachments (see `brief-files`). Only the owning company, admins and the selected
      // student can open them; other students see at most the ids.
      name: 'attachments',
      type: 'upload',
      relationTo: 'brief-files',
      hasMany: true,
      maxRows: MAX_BRIEF_FILES,
    },
    {
      // Konnected's latest note to the company, shown on the company's project page. Written by
      // the team at review. Never shown to students.
      name: 'noteToCompany',
      label: 'Latest note to the company',
      type: 'textarea',
      maxLength: 2000,
      access: teamWritesCompanyReads,
    },
    {
      name: 'noteToCompanyAt',
      label: 'Note written',
      type: 'date',
      access: teamWritesCompanyReads,
      admin: { readOnly: true, position: 'sidebar' },
    },
    // Replaced by `workloadHours` and `durationWeeks`. Kept until a later migration removes the
    // columns (add first, remove later).
    { name: 'workload', type: 'text', ...retired },
    { name: 'duration', type: 'text', ...retired },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: PROJECT_STATUSES,
    },
  ],
}
