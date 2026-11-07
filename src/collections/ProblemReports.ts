import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrStudentField,
  effectiveRole,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import { sendProblemReceivedEmail } from '@/lib/email/problemEmails'
import {
  cleanText,
  PROBLEM_KINDS,
  PROBLEM_NOTE_MAX,
  PROBLEM_RESOLUTIONS,
  PROBLEM_STATUSES,
  REPORTABLE_PROJECT_STATUSES,
} from '@/lib/problems/fields'
import { problemError } from '@/lib/problems/rules'
import {
  assertInitialStatus,
  assertTransition,
  PROBLEM_REPORT_TRANSITIONS,
  type ProblemReportStatus,
} from '@/lib/transitions'

type Rel = number | { id: number } | null | undefined

/** Written by the server only (the hook below). */
const serverOnly = { create: adminOnlyField, update: adminOnlyField }

/**
 * A student's problem report on their own running project: "I need more time" or "I can't
 * finish", with a note only the Konnected team reads (Kanban card "Problem reports").
 *
 * Read: admins all; a student only their own. Companies have no access at all: the company learns
 * the new plan (a new due date, a new student, a closed project) from the project, never the note.
 * Create: the student, for their own match Konnected has not ended, while the project is matched
 * or in progress, one open report at a time. The student, match and project come from the session
 * and the match, never from the request. Update: admins only, to settle the report (the Projects
 * and Matches hooks do it when the team moves the date, ends the match or closes the project; the
 * team may also mark it handled). The note never changes. Delete: admins.
 */
export const ProblemReports: CollectionConfig = {
  slug: 'problem-reports',
  admin: { defaultColumns: ['match', 'kind', 'status', 'createdAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isStudent(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = effectiveRole(req.user)
        if (operation === 'create') {
          assertInitialStatus<ProblemReportStatus>('open', data.status, 'A new problem report')
          if (!isStudent(req.user)) throw problemError('forbidden', 'Only a student reports', 403)
          const matchId = relationId(data.match as Rel)
          if (!matchId) throw problemError('not_found', 'A report needs a match', 400)
          // One report at a time per match: lock the match row (two sends at once run one after
          // the other, and the second sees the first).
          await lockRow(req, 'matches', matchId)
          // Bypass for the reads below: the server checks the match is the student's own and still
          // running; only yes or no leaves here.
          const match = await req.payload.findByID({
            collection: 'matches',
            id: matchId,
            depth: 0,
            select: { student: true, project: true, endedAt: true },
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          const profile = match
            ? await req.payload.findByID({
                collection: 'student-profiles',
                id: relationId(match.student as Rel)!,
                depth: 0,
                select: { user: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!match || !profile || relationId(profile.user as Rel) !== req.user!.id) {
            throw problemError('not_found', 'This match is not yours', 404)
          }
          const projectId = relationId(match.project as Rel)!
          const project = await req.payload.findByID({
            collection: 'projects',
            id: projectId,
            depth: 0,
            select: { status: true },
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (
            match.endedAt ||
            !(REPORTABLE_PROJECT_STATUSES as readonly string[]).includes(project?.status ?? '')
          ) {
            throw problemError('not_open', 'The work on this project is not running', 409)
          }
          const open = await req.payload.count({
            collection: 'problem-reports',
            where: { and: [{ match: { equals: matchId } }, { status: { equals: 'open' } }] },
            overrideAccess: true,
            req,
          })
          if (open.totalDocs > 0) {
            throw problemError('already_open', 'Konnected already has your report', 409)
          }
          if (!(PROBLEM_KINDS as readonly string[]).includes(data.kind)) {
            throw problemError('kind_required', 'Say what you need', 400)
          }
          const note = cleanText(data.note)
          if (!note) throw problemError('note_required', 'Say what happened', 400)
          if (note.length > PROBLEM_NOTE_MAX) throw problemError('note_too_long', 'Too long')
          return {
            match: matchId,
            project: projectId,
            student: relationId(match.student as Rel),
            kind: data.kind,
            note,
            status: 'open',
            resolution: null,
            resolvedAt: null,
          }
        }

        // Update: only the status moves (open to resolved, admins), with how it was settled.
        const from = originalDoc?.status as ProblemReportStatus
        const to = (data.status ?? from) as ProblemReportStatus
        assertTransition(PROBLEM_REPORT_TRANSITIONS, from, to, role, 'Problem report')
        const resolution = from !== to ? data.resolution : originalDoc?.resolution
        if (to === 'resolved' && !(PROBLEM_RESOLUTIONS as readonly string[]).includes(resolution)) {
          throw new APIError('Problem report: say how it was settled', 400)
        }
        // Everything else stays as stored: the student's note and kind, the match and project.
        return {
          ...data,
          match: originalDoc?.match,
          project: originalDoc?.project,
          student: originalDoc?.student,
          kind: originalDoc?.kind,
          note: originalDoc?.note,
          status: to,
          resolution: to === 'resolved' ? resolution : null,
          resolvedAt: from !== to ? new Date().toISOString() : (originalDoc?.resolvedAt ?? null),
        }
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, operation, req }) => {
        // "Konnected has your message", to the student. The note is not repeated.
        if (operation === 'create') await sendProblemReceivedEmail(req, doc)
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
      // Copied from the match by the server (the hook overwrites any value on every save). No
      // field-level create or update access: that runs after the hook and would drop its value.
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      index: true,
      admin: { readOnly: true },
    },
    {
      // Copied from the match by the server, like `project`: the student who reported.
      name: 'student',
      type: 'relationship',
      relationTo: 'student-profiles',
      index: true,
      access: { read: adminOrStudentField },
      admin: { readOnly: true },
    },
    { name: 'kind', type: 'select', required: true, options: [...PROBLEM_KINDS] },
    {
      // What happened, in the student's words. Only the team and the student read it; it is never
      // shown to the company, put in an email or written to the log.
      name: 'note',
      type: 'textarea',
      required: true,
      maxLength: PROBLEM_NOTE_MAX,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'open',
      index: true,
      options: [...PROBLEM_STATUSES],
    },
    {
      name: 'resolution',
      type: 'select',
      options: [...PROBLEM_RESOLUTIONS],
      access: { create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'resolvedAt',
      type: 'date',
      access: serverOnly,
      admin: { readOnly: true, position: 'sidebar' },
    },
  ],
}
