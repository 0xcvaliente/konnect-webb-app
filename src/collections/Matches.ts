import type { Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrCompanyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete, writeActivity } from '@/hooks/logActivity'
import { assertRoomForAnotherProject } from '@/lib/applications/rules'
import { sendDueDateEmails } from '@/lib/email/problemEmails'
import { selectionOf } from '@/lib/matching/rules'
import { REPORTABLE_PROJECT_STATUSES } from '@/lib/problems/fields'
import {
  ACTIVE_MATCH,
  type ProblemContext,
  problemError,
  resolveOpenReports,
} from '@/lib/problems/rules'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'

/**
 * Konnected's pick of a student for a project. Made only by selecting an application (Matching);
 * only admin edits a match, and never its student, project or application.
 *
 * Konnected may end a match (Kanban card "Problem reports"): only by reopening or closing its
 * project (the Projects hook ends it in the same change). An ended match keeps its history for the
 * team and the student, loses its shared copy, and is no longer readable for the company. A project
 * has at most one match that is not ended (a partial unique index, see the migration), so the team
 * can match it again. Moving the due date (`endDate`) keeps the old dates in `dueDateHistory`.
 *
 * A company reads the matches of its own projects, but NOT the `student` or `application`
 * relations (field-level read is admin and student only). What the company learns about the
 * selected student is `sharedInfo`: a copy of only the fields the student agreed to share, made by
 * the hook below. The company never gets a way to reach the student profile.
 */
export const Matches: CollectionConfig = {
  slug: 'matches',
  admin: { defaultColumns: ['project', 'student', 'startDate'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      const companyId = companyIdOf(user)
      // Only the current match: once Konnected ends one, the company reads nothing about it.
      return companyId
        ? { and: [{ 'project.company': { equals: companyId } }, ACTIVE_MATCH] }
        : false
    },
    create: ({ req: { user } }) => isAdmin(user),
    update: ({ req: { user } }) => isAdmin(user),
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        // A key sent as null counts as sent (clearing it is a change too).
        const valueOf = (key: 'student' | 'project' | 'application') =>
          relationId(key in data ? data[key] : originalDoc?.[key])
        const studentId = valueOf('student')
        const projectId = valueOf('project')
        const applicationId = valueOf('application')
        if (!studentId || !projectId)
          throw new APIError('A match needs a student and a project', 400)

        // A match is made only by selecting an application (the Applications hook, which also
        // marks the other applicants not selected and moves the project to matched). Any other
        // attempt to create one, through any API, is refused.
        if (operation === 'create') {
          if (!applicationId || selectionOf(req) !== applicationId) {
            throw new APIError(
              'A match is made by selecting an application. Use Matching in the team workspace.',
              400,
            )
          }
          // Bypass: the server reads the application to check it is the one being selected, for
          // this student and project.
          const application = await req.payload.findByID({
            collection: 'applications',
            id: applicationId,
            depth: 0,
            overrideAccess: true,
            req,
          })
          if (
            application.status !== 'selected' ||
            relationId(application.student) !== studentId ||
            relationId(application.project) !== projectId
          ) {
            throw new APIError('The application is not selected for this student and project', 400)
          }
          // At most 2 running projects per student (checked again here; it locks the profile).
          await assertRoomForAnotherProject(req, studentId, projectId)
        }
        // The student, project and application of a match never change. Ending a match and
        // matching again is its own step (a later card).
        if (
          operation === 'update' &&
          (relationId(originalDoc?.student) !== studentId ||
            relationId(originalDoc?.project) !== projectId ||
            relationId(originalDoc?.application) !== applicationId)
        ) {
          throw new APIError('A match keeps its student, project and application', 400)
        }

        const context = req.context as ProblemContext | undefined
        if (operation === 'update') {
          // An ended match is history: nothing on it changes any more.
          if (originalDoc?.endedAt) {
            throw problemError('not_open', 'This match has ended', 409)
          }
          // A match ends only when Konnected reopens or closes its project (the Projects hook sets
          // the context for this one match). Any other attempt, through any API, is refused.
          if ('endedAt' in data && data.endedAt) {
            if (context?.endingMatch !== originalDoc?.id) {
              throw problemError(
                'forbidden',
                'A match ends when Konnected reopens or closes its project',
                400,
              )
            }
            // Nothing about the student stays on an ended match for anyone but the team.
            data.sharedInfo = {
              name: null,
              school: null,
              programme: null,
              year: null,
              pitch: null,
              skills: [],
              experience: null,
              cv: null,
              contactEmail: null,
              phone: null,
            }
            return data
          }
          // Moving the due date: only while the work runs, to today or later. The old date is kept.
          const before = storedToDay(originalDoc?.endDate)
          const after = 'endDate' in data ? storedToDay(data.endDate) : before
          if (before && after !== before) {
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
              !(REPORTABLE_PROJECT_STATUSES as readonly string[]).includes(project?.status ?? '')
            ) {
              throw problemError('not_open', 'The due date moves only while the work runs', 409)
            }
            if (!after || after < todayInOslo()) {
              throw problemError('date_invalid', 'The new due date must be today or later', 400)
            }
            data.dueDateHistory = [
              ...(originalDoc?.dueDateHistory ?? []),
              { from: originalDoc!.endDate, to: data.endDate, changedAt: new Date().toISOString() },
            ]
          } else {
            // The history is the server's: a client value never sticks.
            data.dueDateHistory = originalDoc?.dueDateHistory ?? []
          }
        } else {
          data.endedAt = null
          data.dueDateHistory = []
        }

        // Bypass for the read below: the server needs the full student profile to copy only the
        // shared fields.
        const profile = await req.payload.findByID({
          collection: 'student-profiles',
          id: studentId,
          depth: 0,
          overrideAccess: true,
          req,
        })
        const privacy = profile.privacy ?? {}
        // Copy only what the student agreed to share. Rebuilt on every save, and again whenever the
        // student changes their profile or what they share (see StudentProfiles).
        data.sharedInfo = {
          name: privacy.shareName ? profile.name : null,
          school: privacy.shareSchool ? profile.school : null,
          programme: privacy.shareSchool ? profile.programme : null,
          year: privacy.shareSchool ? profile.year : null,
          pitch: privacy.sharePitch ? profile.pitch : null,
          // An empty list, not null: a hasMany field ignores null on update and would keep the old copy.
          skills: privacy.shareSkills ? profile.skills : [],
          experience: privacy.shareExperience ? profile.experience : null,
          // The CV itself stays in `cvs`; its read rule checks the same tick on every request.
          cv: privacy.shareCv ? (relationId(profile.cv) ?? null) : null,
          contactEmail: privacy.shareContactEmail ? profile.contactEmail : null,
          phone: privacy.sharePhone ? profile.phone : null,
        }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange(),
      async ({ doc, previousDoc, operation, req }) => {
        if (operation !== 'update') return doc
        const note = (req.context as { activityNote?: string } | undefined)?.activityNote
        // Konnected ended the match (the Projects hook, which writes the reason on the project).
        if (doc.endedAt && !previousDoc?.endedAt) {
          await writeActivity(req, {
            action: 'status_change',
            targetCollection: 'matches',
            targetId: String(doc.id),
            field: 'endedAt',
            fromStatus: 'active',
            toStatus: 'ended',
          })
          return doc
        }
        // The due date moved (or was set in answer to the student's report): log it with the
        // team's note, settle the student's report, and tell both. Setting the first due date at
        // kick-off is not a move: no email then.
        const before = storedToDay(previousDoc?.endDate)
        const after = storedToDay(doc.endDate)
        if (after && before !== after) {
          await writeActivity(req, {
            action: 'review_change',
            targetCollection: 'matches',
            targetId: String(doc.id),
            field: 'endDate',
            fromStatus: before ?? undefined,
            toStatus: after,
            note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : undefined,
          })
          const answered = await resolveOpenReports(req, doc.id, 'date_moved')
          if (before || answered > 0) {
            await sendDueDateEmails(req, doc, previousDoc?.endDate, doc.endDate)
          }
        }
        return doc
      },
      async ({ doc, operation, req }) => {
        // One payment log row per paid match (Kanban card "Manual payment log in admin"), made
        // with the match, in the same transaction, as the team member who selected the student
        // (access control on; the Payments hook refuses unpaid projects and copies the price).
        if (operation !== 'create') return doc
        const projectId = relationId(doc.project)
        // Bypass: read only whether the project is paid; the acting user is the team.
        const project = projectId
          ? await req.payload.findByID({
              collection: 'projects',
              id: projectId,
              depth: 0,
              select: { paidOrUnpaid: true },
              overrideAccess: true,
              disableErrors: true,
              req,
            })
          : null
        if (project?.paidOrUnpaid === 'paid') {
          await req.payload.create({
            collection: 'payments',
            data: { match: doc.id },
            overrideAccess: false,
            req,
          })
        }
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  // One match per project that is not ended: a partial unique index made in the migration
  // (20261107_..._problem_paths), which Payload's `indexes` cannot express.
  fields: [
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      required: true,
      index: true,
    },
    {
      name: 'student',
      type: 'relationship',
      relationTo: 'student-profiles',
      required: true,
      index: true,
      access: { read: adminOrStudentField },
    },
    {
      name: 'application',
      type: 'relationship',
      relationTo: 'applications',
      access: { read: adminOrStudentField },
    },
    {
      name: 'agreementNotes',
      type: 'textarea',
      access: { read: adminOnlyField },
    },
    { name: 'startDate', type: 'date' },
    // The due date, agreed at kick-off. Konnected may move it later; `dueDateHistory` keeps the
    // old dates (the company and the student read the dates, never why).
    { name: 'endDate', type: 'date' },
    {
      name: 'dueDateHistory',
      type: 'array',
      admin: { readOnly: true },
      access: { create: adminOnlyField, update: adminOnlyField },
      fields: [
        { name: 'from', type: 'date' },
        { name: 'to', type: 'date' },
        { name: 'changedAt', type: 'date' },
      ],
    },
    {
      // When Konnected ended the match (set by the server only, with the project's reopen or
      // close). Empty while the match runs. The company never reads an ended match.
      name: 'endedAt',
      type: 'date',
      index: true,
      admin: { readOnly: true, position: 'sidebar' },
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'sharedInfo',
      type: 'group',
      admin: { readOnly: true },
      access: {
        read: ({ req: { user } }) => adminOrCompanyField({ req: { user } }) || isStudent(user),
      },
      fields: [
        { name: 'name', type: 'text' },
        { name: 'school', type: 'text' },
        { name: 'programme', type: 'text' },
        { name: 'year', type: 'number' },
        { name: 'pitch', type: 'textarea' },
        { name: 'skills', type: 'text', hasMany: true },
        { name: 'experience', type: 'textarea' },
        { name: 'cv', type: 'upload', relationTo: 'cvs' },
        { name: 'contactEmail', type: 'email' },
        { name: 'phone', type: 'text' },
      ],
    },
  ],
}
