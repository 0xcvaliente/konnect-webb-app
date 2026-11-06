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

/**
 * Konnected's pick of a student for a project. Only admin creates or edits a match.
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
      async ({ data, originalDoc, req }) => {
        const studentId = relationId(data.student ?? originalDoc?.student)
        const projectId = relationId(data.project ?? originalDoc?.project)
        const applicationId = relationId(data.application ?? originalDoc?.application)
        if (!studentId || !projectId)
          throw new APIError('A match needs a student and a project', 400)

        // Bypass for the reads below: the server needs the full student profile to copy only the
        // shared fields, and the application to check it belongs to this student and project.
        if (applicationId) {
          const application = await req.payload.findByID({
            collection: 'applications',
            id: applicationId,
            depth: 0,
            overrideAccess: true,
            req,
          })
          if (
            relationId(application.student) !== studentId ||
            relationId(application.project) !== projectId
          ) {
            throw new APIError('The application is not for this student and project', 400)
          }
        }

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
          pitch: privacy.sharePitch ? profile.pitch : null,
          // An empty list, not null: a hasMany field ignores null on update and would keep the old copy.
          skills: privacy.shareSkills ? profile.skills : [],
          experience: privacy.shareExperience ? profile.experience : null,
          // The CV itself stays in `cvs`; its read rule checks the same tick on every request.
          cv: privacy.shareCv ? (relationId(profile.cv) ?? null) : null,
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
        { name: 'pitch', type: 'textarea' },
        { name: 'skills', type: 'text', hasMany: true },
        { name: 'experience', type: 'textarea' },
        { name: 'cv', type: 'upload', relationTo: 'cvs' },
      ],
    },
  ],
}
