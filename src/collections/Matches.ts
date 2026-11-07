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
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { assertRoomForAnotherProject } from '@/lib/applications/rules'
import { selectionOf } from '@/lib/matching/rules'

/**
 * Konnected's pick of a student for a project. Made only by selecting an application (Matching);
 * only admin edits a match, and never its student, project or application.
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
      return companyId ? { 'project.company': { equals: companyId } } : false
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
    afterChange: [logActivityAfterChange()],
    afterDelete: [logActivityAfterDelete()],
  },
  indexes: [{ fields: ['project'], unique: true }],
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
    { name: 'endDate', type: 'date' },
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
