import fs from 'node:fs/promises'

import {
  APIError,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  type Where,
} from 'payload'

import { isAdmin, relationId } from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { checkTemplate } from '@/lib/agreements/docx'
import {
  AGREEMENT_KINDS,
  type AgreementKind,
  TEMPLATE_MAX_BYTES,
  type TemplateStatus,
  TEMPLATE_STATUSES,
} from '@/lib/agreements/fields'
import {
  checkUpload,
  privateUpload,
  setOriginalName,
  type UploadRule,
} from '@/lib/uploads/fileRules'
import { assertTransition, type TransitionMap } from '@/lib/transitions'

/** Word (.docx) only, 5 MB. Macro files (.docm) are detected by content and refused. */
export const TEMPLATE_RULE: UploadRule = { kinds: ['docx'], maxBytes: TEMPLATE_MAX_BYTES }

/** draft -> published -> retired. A draft can be retired without ever being published. */
export const TEMPLATE_TRANSITIONS: TransitionMap<TemplateStatus> = {
  draft: { published: ['admin'], retired: ['admin'] },
  published: { retired: ['admin'] },
}

const FIELDS_KEY = 'agreementTemplateFields'

type IncomingFile = { data?: Buffer; tempFilePath?: string; name: string }

/**
 * Check the Word file before Payload stores it: the right kind of file, within the limits, and
 * only fields the agreement may hold (lib/agreements/docx.ts). The refusal says what is wrong
 * (`data.problem`), so the team screen can show it in EN and NO. The fields found are kept for
 * the beforeChange hook, so `fields` always comes from the file, never from the request.
 */
const checkTemplateFile: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'create' && operation !== 'update') return args
  const file = req.file as IncomingFile | undefined
  if (operation === 'update') {
    // A version never changes: a new file is a new upload, with a new version number.
    if (file) throw new APIError('Upload a new version instead of replacing the file.', 400)
    return args
  }
  if (!file) throw new APIError('A template needs a Word file.', 400)
  const kind = (args.data as { kind?: unknown } | undefined)?.kind
  if (!AGREEMENT_KINDS.includes(kind as AgreementKind)) {
    throw new APIError('Choose which agreement this template is for.', 400, {
      problem: { code: 'kind' },
    })
  }
  const buffer = file.data?.length
    ? file.data
    : file.tempFilePath
      ? await fs.readFile(file.tempFilePath)
      : Buffer.alloc(0)
  const result = await checkTemplate(buffer, kind as AgreementKind)
  if (!result.ok) {
    throw new APIError('This template cannot be used.', 400, { problem: result.problem }, true)
  }
  req.context[FIELDS_KEY] = result.fields
  return args
}

/**
 * Konnected's agreement templates: Word files with `{{fields}}`, written by the team (legal text
 * never lives in code). Admins only, for every operation and every API.
 *
 * Each upload of a kind gets the next version number. A template starts as a draft; publishing it
 * retires the published one of the same kind, so new agreements always use the newest published
 * version, while agreements already made keep the version they were made from (a copy of the
 * number on the agreement, and the file never changes). Only drafts can be deleted.
 */
export const AgreementTemplates: CollectionConfig = {
  slug: 'agreement-templates',
  admin: {
    useAsTitle: 'originalName',
    defaultColumns: ['kind', 'version', 'status', 'originalName', 'createdAt'],
  },
  disableDuplicate: true,
  upload: privateUpload('agreement-templates', TEMPLATE_RULE),
  access: {
    read: ({ req: { user } }) => isAdmin(user),
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }): Where | boolean =>
      isAdmin(user) ? { status: { equals: 'draft' } } : false,
  },
  hooks: {
    beforeOperation: [checkTemplateFile, checkUpload(TEMPLATE_RULE)],
    beforeChange: [
      setOriginalName,
      async ({ data, originalDoc, operation, req }) => {
        const now = new Date().toISOString()
        if (operation === 'create') {
          const kind = data.kind as AgreementKind
          // Bypass: the latest version of this kind, whoever asks. Only the number is used.
          const latest = await req.payload.find({
            collection: 'agreement-templates',
            where: { kind: { equals: kind } },
            sort: '-version',
            limit: 1,
            depth: 0,
            select: { version: true },
            overrideAccess: true,
            req,
          })
          data.version = (latest.docs[0]?.version ?? 0) + 1
          data.fields = (req.context[FIELDS_KEY] as string[] | undefined) ?? []
          data.status = 'draft'
          data.uploadedBy = req.user?.id ?? null
          data.publishedAt = null
          data.retiredAt = null
          data.publishedKind = null
          return data
        }

        // Kind, version, fields and uploader never change after the upload.
        for (const key of ['kind', 'version', 'fields', 'uploadedBy'] as const) {
          data[key] =
            key === 'uploadedBy'
              ? (relationId(originalDoc?.uploadedBy) ?? null)
              : originalDoc?.[key]
        }
        const from = originalDoc?.status as TemplateStatus
        const to = (data.status ?? from) as TemplateStatus
        assertTransition(
          TEMPLATE_TRANSITIONS,
          from,
          to,
          isAdmin(req.user) ? 'admin' : undefined,
          'Template',
        )
        if (to === 'published' && from !== 'published') {
          // One published template per kind: the previous one is retired in the same
          // transaction. The unique `publishedKind` index catches two publishes at once.
          const current = await req.payload.find({
            collection: 'agreement-templates',
            where: {
              and: [{ kind: { equals: originalDoc?.kind } }, { status: { equals: 'published' } }],
            },
            depth: 0,
            pagination: false,
            select: { status: true },
            overrideAccess: true,
            req,
          })
          for (const doc of current.docs) {
            await req.payload.update({
              collection: 'agreement-templates',
              id: doc.id,
              data: { status: 'retired' },
              depth: 0,
              overrideAccess: true,
              req,
            })
          }
          data.publishedAt = now
          data.publishedKind = originalDoc?.kind
        }
        if (to === 'retired' && from !== 'retired') {
          data.retiredAt = now
          data.publishedKind = null
        }
        if (to === from) {
          data.publishedAt = originalDoc?.publishedAt ?? null
          data.retiredAt = originalDoc?.retiredAt ?? null
          data.publishedKind = originalDoc?.publishedKind ?? null
        }
        return data
      },
    ],
    afterChange: [logActivityAfterChange({ statusField: 'status' })],
    afterDelete: [logActivityAfterDelete()],
    // Keep the reason for a refused upload in the REST answer. Payload adds `data` only when the
    // error is its own APIError class, which a bundled build can see as a different class.
    afterError: [
      ({ error, result }) => {
        const problem = (error as { data?: { problem?: unknown } }).data?.problem
        if (!problem) return
        const base = (result ?? {}) as { errors?: { message?: string }[] }
        return {
          response: {
            ...base,
            errors: [{ message: base.errors?.[0]?.message ?? error.message, data: { problem } }],
          },
          status: 400,
        }
      },
    ],
  },
  indexes: [{ fields: ['kind', 'version'], unique: true }],
  fields: [
    {
      name: 'kind',
      type: 'select',
      required: true,
      index: true,
      options: [...AGREEMENT_KINDS],
    },
    { name: 'version', type: 'number', admin: { readOnly: true } },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'draft',
      index: true,
      options: [...TEMPLATE_STATUSES],
    },
    {
      // The fields found in the Word file at upload. Set by the server from the file.
      name: 'fields',
      type: 'json',
      admin: { readOnly: true },
    },
    {
      // The kind while published, else empty. Unique, so at most one published template per
      // kind, even when two people publish at the same moment.
      name: 'publishedKind',
      type: 'text',
      unique: true,
      admin: { hidden: true },
    },
    {
      name: 'uploadedBy',
      type: 'relationship',
      relationTo: 'users',
      admin: { readOnly: true },
    },
    { name: 'publishedAt', type: 'date', admin: { readOnly: true } },
    { name: 'retiredAt', type: 'date', admin: { readOnly: true } },
    { name: 'originalName', type: 'text', admin: { readOnly: true } },
  ],
}
