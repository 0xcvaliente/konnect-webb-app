import type { PayloadRequest, Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrStudentField,
  companyIdOf,
  effectiveRole,
  isAdmin,
  isCompany,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import {
  ACCEPTED_BY,
  type AcceptedBy,
  type DeliverableError,
  type DeliveryItem,
  deliveryState,
  DELIVERABLE_STATUSES,
  fixWindowOver,
  isWebLink,
  LINK_LABEL_MAX,
  MAX_LINKS,
  NOTE_MAX,
  RELEASED_STATUSES,
  WORK_PROJECT_STATUSES,
} from '@/lib/deliverables/fields'
import { sendDeliverableEmails } from '@/lib/email/deliverableEmails'
import {
  assertInitialStatus,
  assertTransition,
  DELIVERABLE_TRANSITIONS,
  type DeliverableStatus,
} from '@/lib/transitions'
import type { Deliverable } from '@/payload-types'
import { MAX_DELIVERABLE_FILES } from './DeliverableFiles'

/** Context keys the server sets. A client cannot set `req.context` through any API. */
export type DeliverableContext = {
  /** The scheduled job records that the 7 days after a release are over. */
  autoAccept?: boolean
}

/** An APIError with a code the pages map to their own message. */
const fail = (code: DeliverableError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

type Rel = number | { id: number } | null | undefined

/** Fields only the server sets. Kept as stored on every update unless a status change sets them. */
const SERVER_FIELDS = [
  'submittedAt',
  'releasedAt',
  'returnedAt',
  'returnNote',
  'fixRequestedAt',
  'fixNote',
  'acceptedAt',
  'acceptedBy',
] as const

/**
 * The hand-ins on a match and the project's status. Bypass: the server reads them whatever the
 * acting user may read (a company does not read the unreleased ones), only to apply the rules.
 */
async function workOn(req: PayloadRequest, matchId: number) {
  const match = await req.payload.findByID({
    collection: 'matches',
    id: matchId,
    depth: 0,
    select: { project: true, student: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!match) return null
  const projectId = relationId(match.project as Rel)
  const project = projectId
    ? await req.payload.findByID({
        collection: 'projects',
        id: projectId,
        depth: 0,
        select: { status: true },
        overrideAccess: true,
        disableErrors: true,
        req,
      })
    : null
  const items = await req.payload.find({
    collection: 'deliverables',
    where: { match: { equals: matchId } },
    depth: 0,
    pagination: false,
    select: { status: true, createdAt: true, releasedAt: true, fixRequestedAt: true },
    overrideAccess: true,
    req,
  })
  return {
    match,
    projectStatus: project?.status ?? null,
    items: items.docs as DeliveryItem[],
  }
}

/**
 * The project of a match, with its status. Bypass: the server reads it whatever the acting user
 * may read, only to apply the rules and to lock it.
 */
async function projectOfMatch(req: PayloadRequest, matchId: number | null | undefined) {
  if (!matchId) return null
  const match = await req.payload.findByID({
    collection: 'matches',
    id: matchId,
    depth: 0,
    select: { project: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return relationId(match?.project as Rel) ?? null
}

const cleanNote = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const note = value.trim()
  return note ? note : null
}

/**
 * Work a student hands in for a match: files (`deliverable-files`, uploaded first for the same
 * match), links and a note. The flow and its rules are in lib/deliverables/fields.ts.
 *
 * Read: admins; the matched student their own; a company only hand-ins Konnected released, and
 * only for its own projects (never what the team asked the student). Create: the matched student
 * (and admins on their behalf). Update: admins; the company only to accept a release or ask for its
 * one round of fixes. A student cannot change a hand-in after sending it. Delete: admins.
 */
export const Deliverables: CollectionConfig = {
  slug: 'deliverables',
  admin: { defaultColumns: ['match', 'status', 'submittedAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'match.student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      return companyId
        ? {
            and: [
              { 'match.project.company': { equals: companyId } },
              { status: { in: [...RELEASED_STATUSES] } },
            ],
          }
        : false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      const companyId = companyIdOf(user)
      return companyId
        ? {
            and: [
              { 'match.project.company': { equals: companyId } },
              { status: { equals: 'released' } },
            ],
          }
        : false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req, context }) => {
        const role = effectiveRole(req.user)
        const now = new Date().toISOString()

        if (operation === 'create') {
          assertInitialStatus<DeliverableStatus>('submitted', data.status, 'A new deliverable')
          const matchId = relationId(data.match as Rel)
          if (!matchId) throw fail('not_found', 'A deliverable needs a match', 400)
          // Lock order: the project, then the match. The project in share mode, so Konnected
          // closing it (lib/deliverables/gates.ts) waits for this hand-in or runs before it; two
          // hand-ins at once on one match run one after the other.
          const projectId = await projectOfMatch(req, matchId)
          if (projectId) await lockRow(req, 'projects', projectId, 'share')
          await lockRow(req, 'matches', matchId)
          const work = await workOn(req, matchId)
          if (!work) throw fail('not_found', 'The match does not exist', 404)

          if (!isAdmin(req.user)) {
            // The student hands in only for their own match. Bypass: the server reads the profile's
            // user to compare it with the session.
            const profile = await req.payload.findByID({
              collection: 'student-profiles',
              id: relationId(work.match.student as Rel)!,
              depth: 0,
              select: { user: true },
              overrideAccess: true,
              disableErrors: true,
              req,
            })
            if (!profile || relationId(profile.user as Rel) !== req.user?.id) {
              throw fail('forbidden', 'This match is not yours', 403)
            }
          }

          const state = deliveryState(work.items, work.projectStatus)
          if (state.blocked === 'not_started')
            throw fail('not_started', 'The work on this project has not started', 409)
          if (state.blocked === 'closed') throw fail('closed', 'The project is closed', 409)
          if (state.blocked === 'waiting')
            throw fail('waiting', 'A hand-in already waits for Konnected', 409)
          if (state.blocked === 'done')
            throw fail('done', 'The work was released; nothing more to hand in', 409)

          // Links: web addresses only, with a short label.
          const links = Array.isArray(data.links) ? data.links : []
          if (links.length > MAX_LINKS) throw fail('too_many_links', 'Too many links', 400)
          data.links = links.map((link: { label?: unknown; url?: unknown }) => {
            if (!isWebLink(link?.url)) throw fail('bad_link', 'A link is not a web address', 400)
            const label = typeof link.label === 'string' ? link.label.trim() : ''
            return { label: label.slice(0, LINK_LABEL_MAX) || null, url: link.url.trim() }
          })
          const files = Array.isArray(data.files) ? data.files : []
          if (files.length > MAX_DELIVERABLE_FILES)
            throw fail('too_many_files', 'Too many files', 400)
          if (!files.length && !data.links.length)
            throw fail('empty', 'Add at least one file or link', 400)
          const note = cleanNote(data.note)
          if (note && note.length > NOTE_MAX) throw fail('note_too_long', 'The note is too long')
          data.note = note

          for (const key of SERVER_FIELDS) data[key] = null
          data.status = 'submitted'
          data.submittedAt = now
          return data
        }

        // Update. The hand-in's status may have changed since this request read it: lock the row
        // and read it again, so two people deciding at once run one after the other. A release or
        // a fix request depends on the project still running: lock the project first (lock order:
        // project, then the work on it), so Konnected closing it runs before or after, not between.
        const id = originalDoc!.id as number
        const opensWork =
          data.status !== originalDoc!.status &&
          (data.status === 'released' || data.status === 'fix_requested')
        const projectId = opensWork
          ? await projectOfMatch(req, relationId(originalDoc!.match as Rel))
          : null
        if (projectId) await lockRow(req, 'projects', projectId)
        await lockRow(req, 'deliverables', id)
        const fresh = await req.payload.findByID({
          collection: 'deliverables',
          id,
          depth: 0,
          select: { status: true },
          overrideAccess: true,
          disableErrors: true,
          req,
        })
        const from = originalDoc!.status as DeliverableStatus
        if (!fresh || fresh.status !== from) {
          throw fail('not_open', 'The deliverable changed meanwhile. Load it again.', 409)
        }
        const to = (data.status ?? from) as DeliverableStatus
        const automatic =
          (context as DeliverableContext | undefined)?.autoAccept === true &&
          from === 'released' &&
          to === 'accepted' &&
          Boolean(originalDoc?.releasedAt) &&
          fixWindowOver(originalDoc!.releasedAt)
        if (!automatic) assertTransition(DELIVERABLE_TRANSITIONS, from, to, role, 'Deliverable')

        // The match of a hand-in never changes.
        if ('match' in data && relationId(data.match as Rel) !== relationId(originalDoc!.match)) {
          throw new APIError('A deliverable keeps its match', 400)
        }

        const incoming = { returnNote: data.returnNote, fixNote: data.fixNote }
        for (const key of SERVER_FIELDS) data[key] = originalDoc?.[key] ?? null
        if (from === to) return data

        // Releasing work, or asking for its fix, only while the project runs. Once Konnected
        // closed it, the student can hand in nothing more.
        if (to === 'released' || to === 'fix_requested') {
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: projectId,
                depth: 0,
                select: { status: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!(WORK_PROJECT_STATUSES as readonly string[]).includes(project?.status ?? '')) {
            throw project?.status === 'closed'
              ? fail('closed', 'The project is closed', 409)
              : fail('not_started', 'The work on this project has not started', 409)
          }
        }

        if (to === 'released') {
          data.releasedAt = now
        } else if (to === 'returned') {
          const note = cleanNote(incoming.returnNote)
          if (!note) throw fail('note_required', 'Say what the student should add or fix')
          if (note.length > NOTE_MAX) throw fail('note_too_long', 'The note is too long')
          data.returnNote = note
          data.returnedAt = now
        } else if (to === 'fix_requested') {
          const note = cleanNote(incoming.fixNote)
          if (!note) throw fail('note_required', 'Say what should be fixed')
          if (note.length > NOTE_MAX) throw fail('note_too_long', 'The note is too long')
          const work = await workOn(req, relationId(originalDoc!.match as Rel)!)
          if (!work) throw fail('not_found', 'The match does not exist', 404)
          if (
            work.items.some(
              (d) => d.id !== id && (d.fixRequestedAt || d.status === 'fix_requested'),
            )
          )
            throw fail('fix_used', 'The one round of fixes was already used', 409)
          if (!originalDoc?.releasedAt || fixWindowOver(originalDoc.releasedAt))
            throw fail('fix_window', 'The 7 days to ask for fixes are over', 409)
          data.fixNote = note
          data.fixRequestedAt = now
        } else if (to === 'accepted') {
          data.acceptedAt = now
          data.acceptedBy = (
            automatic ? 'auto' : isCompany(req.user) ? 'company' : 'team'
          ) as AcceptedBy
        }
        return data
      },
      async ({ data, originalDoc, req }) => {
        // Every file must have been uploaded for this deliverable's match. Bypass: the server
        // reads the files' match, whatever the acting user may read.
        const fileIds = (data.files ?? []).map(relationId).filter(Boolean) as number[]
        if (!fileIds.length) return data
        const matchId = relationId(data.match ?? originalDoc?.match)
        const files = await req.payload.find({
          collection: 'deliverable-files',
          where: { id: { in: fileIds } },
          depth: 0,
          pagination: false,
          overrideAccess: true,
          req,
        })
        const ok = new Set(
          files.docs.filter((f) => relationId(f.match) === matchId).map((f) => f.id),
        )
        if (fileIds.some((id) => !ok.has(id))) {
          throw new APIError('A file does not belong to this match', 403)
        }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, previousDoc, operation, req }) => {
        if (operation !== 'update' || doc.status === previousDoc?.status) return doc
        const deliverable = doc as Deliverable
        if (deliverable.status === 'released') {
          // The first release delivers the project. Done as the team member who released it, with
          // access control on, so the project's own rules and activity log apply.
          const match = await req.payload.findByID({
            collection: 'matches',
            id: relationId(deliverable.match as Rel)!,
            depth: 0,
            select: { project: true },
            overrideAccess: true,
            req,
          })
          const projectId = relationId(match.project as Rel)
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: projectId,
                depth: 0,
                select: { status: true },
                overrideAccess: true,
                req,
              })
            : null
          if (project?.status === 'in_progress') {
            await req.payload.update({
              collection: 'projects',
              id: project.id,
              data: { status: 'delivered' },
              overrideAccess: false,
              req,
            })
          }
        }
        await sendDeliverableEmails(req, deliverable)
        return doc
      },
    ],
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
      // The student's note to Konnected and the company about the work.
      name: 'note',
      type: 'textarea',
      maxLength: NOTE_MAX,
      access: { update: adminOnlyField },
    },
    {
      name: 'files',
      type: 'upload',
      relationTo: 'deliverable-files',
      hasMany: true,
      maxRows: MAX_DELIVERABLE_FILES,
      access: { update: adminOnlyField },
    },
    {
      name: 'links',
      type: 'array',
      maxRows: MAX_LINKS,
      access: { update: adminOnlyField },
      fields: [
        { name: 'label', type: 'text', maxLength: LINK_LABEL_MAX },
        { name: 'url', type: 'text', required: true },
      ],
    },
    {
      // Changed only through the hook's rules (lib/transitions.ts).
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'submitted',
      index: true,
      options: [...DELIVERABLE_STATUSES],
    },
    { name: 'submittedAt', type: 'date', admin: { readOnly: true } },
    {
      // When Konnected released it to the company. The 7 days for fixes start here.
      name: 'releasedAt',
      type: 'date',
      index: true,
      admin: { readOnly: true },
    },
    {
      // What the team asked the student to add or fix before release. Never shown to the company.
      name: 'returnNote',
      type: 'textarea',
      admin: { readOnly: true },
      access: { read: adminOrStudentField },
    },
    {
      name: 'returnedAt',
      type: 'date',
      admin: { readOnly: true },
      access: { read: adminOrStudentField },
    },
    {
      // What the company asked to fix (its one round). The student sees it.
      name: 'fixNote',
      type: 'textarea',
      admin: { readOnly: true },
    },
    { name: 'fixRequestedAt', type: 'date', admin: { readOnly: true } },
    { name: 'acceptedAt', type: 'date', admin: { readOnly: true } },
    {
      name: 'acceptedBy',
      type: 'select',
      options: [...ACCEPTED_BY],
      admin: { readOnly: true },
    },
  ],
}
