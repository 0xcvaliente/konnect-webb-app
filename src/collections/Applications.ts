import type { Where } from 'payload'
import { type CollectionConfig } from 'payload'

import {
  adminOnlyField,
  adminOrStudentField,
  effectiveRole,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { MAX_RUNNING_PROJECTS, NOTE_MAX } from '@/lib/applications/fields'
import {
  applyError,
  assertRoomForAnotherProject,
  runningProjectCount,
} from '@/lib/applications/rules'
import { sendApplicationReceivedEmail } from '@/lib/email/applicationEmails'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'
import {
  APPLICATION_TRANSITIONS,
  assertInitialStatus,
  assertTransition,
  type ApplicationStatus,
} from '@/lib/transitions'

/** Written by the server only (the hook below); the team may read them. */
const serverDate = {
  type: 'date' as const,
  access: { create: adminOnlyField, update: adminOnlyField },
  admin: { readOnly: true, position: 'sidebar' as const },
}

/**
 * A student's application to a project. Companies have no access at all, so a company never learns
 * who applied. A student reads and withdraws only their own applications.
 *
 * Unique on (student, project) in the database. See the migration. This also stops two
 * simultaneous requests, and it is what keeps a withdrawn application final: there is no
 * re-applying after withdrawing (owner rule, 6 Nov 2026).
 *
 * Applying (a student, for themselves): the project is published and applications are still open;
 * the student has a profile that Konnected has not sent back for changes; the student works on
 * fewer than 2 projects; a short note says why they fit. A profile still waiting for review may
 * apply, and the application is marked for the team (`profileWaiting`).
 */
export const Applications: CollectionConfig = {
  slug: 'applications',
  admin: { defaultColumns: ['project', 'student', 'status', 'profileWaiting', 'createdAt'] },
  indexes: [{ fields: ['student', 'project'], unique: true }],
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { 'student.user': { equals: user!.id } }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        const role = effectiveRole(req.user)
        const now = new Date().toISOString()

        if (operation === 'create') {
          assertInitialStatus<ApplicationStatus>('applied', data.status, 'A new application')
          data.status = 'applied'

          // Bypass for the reads below: a student cannot read every profile or a project's
          // closing day through every status; the server reads only what the rules need.
          if (role === 'student') {
            // The applicant always comes from the session, never from the request body.
            const profiles = await req.payload.find({
              collection: 'student-profiles',
              where: { user: { equals: req.user!.id } },
              limit: 1,
              depth: 0,
              overrideAccess: true,
              req,
            })
            const own = profiles.docs[0]
            if (!own) throw applyError('no_profile', 'Create your profile before you apply')
            data.student = own.id
          }
          const studentId = relationId(data.student)
          const profile = studentId
            ? await req.payload.findByID({
                collection: 'student-profiles',
                id: studentId,
                depth: 0,
                select: { reviewStatus: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!profile) throw applyError('no_profile', 'An application needs a student profile')

          // Konnected asked the student to change their profile: the changes come first.
          const review = profile.reviewStatus ?? 'waiting'
          if (role === 'student' && review === 'changes_requested') {
            throw applyError(
              'changes_requested',
              'Make the changes Konnected asked for in your profile before you apply',
              403,
            )
          }
          // A profile still waiting for review may apply; the team sees it on the application.
          data.profileWaiting = review !== 'reviewed'

          // Why the student fits. Required when a student applies; the team may type one in.
          const note = typeof data.note === 'string' ? data.note.trim() : ''
          if (role === 'student' && !note) {
            throw applyError('note_required', 'Write a short note on why you fit this project')
          }
          if (note.length > NOTE_MAX) {
            throw applyError('note_too_long', `The note is longer than ${NOTE_MAX} characters`)
          }
          data.note = note || null

          // The project must be published, and applications open (the closing day is today or
          // later in Oslo, or not set).
          const projectId = relationId(data.project)
          const project = projectId
            ? await req.payload.findByID({
                collection: 'projects',
                id: projectId,
                depth: 0,
                select: { status: true, deadline: true, title: true, companyName: true },
                overrideAccess: true,
                disableErrors: true,
                req,
              })
            : null
          if (!project || project.status !== 'published') {
            throw applyError('not_open', 'You can only apply to a published project')
          }
          const closes = storedToDay(project.deadline)
          if (closes && closes < todayInOslo()) {
            throw applyError('closed', 'Applications for this project are closed')
          }
          // What the student applied to, kept on the application: a student reads published
          // projects only, so My applications still names the project after Konnected matches
          // or closes it.
          data.projectTitle = project.title
          data.companyName = project.companyName ?? null
          data.closesOn = project.deadline ?? null

          // One application per student and project, ever. The unique index is the real guard
          // (also under two requests at once); this check only gives the clear answer.
          const earlier = await req.payload.find({
            collection: 'applications',
            where: {
              and: [{ student: { equals: profile.id } }, { project: { equals: project.id } }],
            },
            limit: 1,
            depth: 0,
            select: { status: true },
            overrideAccess: true,
            req,
          })
          const before = earlier.docs[0]
          if (before?.status === 'withdrawn') {
            throw applyError(
              'withdrawn_before',
              'You withdrew your application to this project, so you cannot apply again',
              409,
            )
          }
          if (before)
            throw applyError('already_applied', 'You already applied to this project', 409)

          // At most 2 running projects per student.
          if ((await runningProjectCount(req.payload, profile.id, req)) >= MAX_RUNNING_PROJECTS) {
            throw applyError(
              'too_many',
              `You already work on ${MAX_RUNNING_PROJECTS} projects, the most at one time`,
              403,
            )
          }
          return data
        }

        const from = originalDoc?.status as ApplicationStatus
        const to = (data.status ?? from) as ApplicationStatus
        assertTransition(APPLICATION_TRANSITIONS, from, to, role, 'Application')
        // At most 2 running projects per student: selecting is a pick, checked on the server.
        if (from !== to && to === 'selected') {
          await assertRoomForAnotherProject(
            req,
            relationId(originalDoc?.student),
            relationId(originalDoc?.project),
          )
        }
        // When each step happened, for the student's progress and the team. Server only.
        if (from !== to) {
          if (to === 'shortlisted') data.shortlistedAt = now
          if (to === 'selected' || to === 'not_selected') data.decidedAt = now
          if (to === 'withdrawn') data.withdrawnAt = now
        }
        return data
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, operation, req }) => {
        // "We received your application", in the student's language. Sent after the response.
        if (operation === 'create') await sendApplicationReceivedEmail(req, doc)
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'student',
      type: 'relationship',
      relationTo: 'student-profiles',
      required: true,
      index: true,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    {
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      required: true,
      index: true,
      access: { update: adminOnlyField },
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'applied',
      index: true,
      options: ['applied', 'shortlisted', 'selected', 'not_selected', 'withdrawn'],
    },
    {
      // Why the student fits, written when applying. Fixed after that.
      name: 'note',
      type: 'textarea',
      maxLength: NOTE_MAX,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    {
      // The student's profile was not reviewed yet when they applied. Set by the server; for the
      // team only.
      name: 'profileWaiting',
      label: 'Profile not reviewed when applying',
      type: 'checkbox',
      defaultValue: false,
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // Copies made by the server when the student applies (see the hook).
      name: 'projectTitle',
      label: 'Project title when applying',
      type: 'text',
      access: { create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true },
    },
    {
      name: 'companyName',
      label: 'Company when applying',
      type: 'text',
      access: { create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true },
    },
    { name: 'closesOn', label: 'Applications closed on (when applying)', ...serverDate },
    { name: 'shortlistedAt', label: 'Shortlisted', ...serverDate },
    { name: 'decidedAt', label: 'Decided', ...serverDate },
    { name: 'withdrawnAt', label: 'Withdrawn', ...serverDate },
  ],
}
