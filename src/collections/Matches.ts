import type { PayloadRequest, Where } from 'payload'
import { APIError, type CollectionConfig } from 'payload'

import type { Match } from '@/payload-types'

import {
  adminOnlyField,
  adminOrCompanyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isStudent,
  relationId,
} from '@/access/roles'
import { isOnTeam } from '@/access/team'
import { logActivityAfterChange, logActivityAfterDelete, writeActivity } from '@/hooks/logActivity'
import { assertRoomForAnotherProject } from '@/lib/applications/rules'
import { KICKOFF_LIMITS } from '@/lib/kickoff/fields'
import { kickoffError, type KickoffContext, studentAgreementInUse } from '@/lib/kickoff/rules'
import { sendDueDateEmails } from '@/lib/email/problemEmails'
import { selectionOf } from '@/lib/matching/rules'
import { firstName } from '@/lib/team/members'
import { REPORTABLE_PROJECT_STATUSES } from '@/lib/problems/fields'
import {
  ACTIVE_MATCH,
  type ProblemContext,
  problemError,
  resolveOpenReports,
} from '@/lib/problems/rules'
import { storedToDay, todayInOslo } from '@/lib/projects/fields'

type MatchData = Partial<Match> & Record<string, unknown>

type KickoffGroup = NonNullable<Match['kickoff']>

/** The parts of the kick-off the team writes, comparable between a save and the stored match. */
const kickoffKey = (k: Partial<KickoffGroup> | null | undefined) =>
  JSON.stringify([
    (k?.scope ?? '').trim(),
    (k?.delivery ?? '').trim(),
    relationId(k?.contact as number | { id: number } | null | undefined) ?? null,
    (k?.checkIns ?? []).map((c) => storedToDay(c?.day)).filter(Boolean),
  ])

/** Does this save change what the team wrote at kick-off? */
function kickoffChanged(next: unknown, stored: Match['kickoff']): boolean {
  if (!next || typeof next !== 'object') return false
  const merged = { ...(stored ?? {}), ...(next as Partial<KickoffGroup>) }
  return kickoffKey(merged) !== kickoffKey(stored)
}

/**
 * Check a kick-off save, for every API (only admins can update a match at all): the project is
 * matched (the work has not started), no student agreement is made from the match, the contact is
 * on the team, and the check-ins are days. Sets when it was first recorded and the contact's name.
 */
async function checkKickoff(
  req: PayloadRequest,
  data: MatchData,
  originalDoc: Match | undefined,
  projectId: number,
): Promise<void> {
  const project = await req.payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (project?.status !== 'matched') {
    throw kickoffError('not_open', 'The kick-off is fixed once the work has started', 409)
  }
  if (await studentAgreementInUse(req, originalDoc!.id)) {
    throw kickoffError(
      'agreement_in_use',
      'A student agreement is made from this kick-off. Withdraw it first.',
      409,
    )
  }
  const kickoff = {
    ...(originalDoc?.kickoff ?? {}),
    ...((data.kickoff as object) ?? {}),
  } as NonNullable<Match['kickoff']>
  const contactId = relationId(kickoff.contact as number | { id: number } | null | undefined)
  if (!contactId || !(await isOnTeam(req, contactId))) {
    throw kickoffError('contact_required', 'The kick-off contact must be on the team', 400)
  }
  // Bypass: the server reads the team member's name to copy it; students and companies cannot
  // read team users.
  const contact = await req.payload.findByID({
    collection: 'users',
    id: contactId,
    depth: 0,
    select: { name: true, email: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  if (!kickoff.scope?.trim()) throw kickoffError('scope_required', 'Write the agreed scope', 400)
  if (!kickoff.delivery?.trim()) {
    throw kickoffError('delivery_required', 'Say how the student delivers', 400)
  }
  const start = storedToDay('startDate' in data ? data.startDate : originalDoc?.startDate)
  const due = storedToDay('endDate' in data ? data.endDate : originalDoc?.endDate)
  if (!start) throw kickoffError('start_invalid', 'The kick-off needs a start date', 400)
  if (!due) throw kickoffError('due_invalid', 'The kick-off needs a due date', 400)
  if (due < start) throw kickoffError('due_before_start', 'The due date is before the start', 400)
  const checkIns = (kickoff.checkIns ?? []).filter((c) => c && c.day)
  if (checkIns.length > KICKOFF_LIMITS.checkIns) {
    throw kickoffError('too_many_check_ins', 'Too many check-in dates', 400)
  }
  for (const c of checkIns) {
    const d = storedToDay(c.day)
    if (!d || d < start || d > due) {
      throw kickoffError('check_in_invalid', 'A check-in falls outside the work', 400)
    }
  }
  data.kickoff = {
    scope: kickoff.scope ?? null,
    delivery: kickoff.delivery ?? null,
    checkIns: checkIns.map((c) => ({ day: c.day })),
    contact: contactId,
    contactName: contact?.name?.trim() || firstName(contact?.email ?? ''),
    recordedAt: originalDoc?.kickoff?.recordedAt ?? new Date().toISOString(),
  }
}

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

        const context = req.context as (ProblemContext & KickoffContext) | undefined
        // Saving the kick-off (lib/kickoff/team.ts) sets the plan before the work starts: its
        // dates are not a move of the due date.
        const kickoffEdit = operation === 'update' && context?.kickoffSave === originalDoc?.id
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
          // The kick-off: only while the project is matched and no student agreement is made from
          // it. When it was first recorded and the contact's name are the server's.
          if (kickoffEdit || kickoffChanged(data.kickoff, originalDoc?.kickoff)) {
            await checkKickoff(req, data, originalDoc, projectId)
          } else {
            // Nothing of the kick-off changed (Payload sends the group with every save): keep it
            // as stored, with the server's own fields.
            data.kickoff = originalDoc?.kickoff ?? {}
          }
          // Moving the due date: only while the work runs, to today or later. The old date is kept.
          const before = storedToDay(originalDoc?.endDate)
          const after = 'endDate' in data ? storedToDay(data.endDate) : before
          if (before && after !== before && !kickoffEdit) {
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
          // The kick-off comes after the selection, never with it.
          data.kickoff = {}
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
        // The kick-off was recorded or changed (lib/kickoff): log who did it, not what it says.
        if ((req.context as KickoffContext | undefined)?.kickoffSave === doc.id) {
          await writeActivity(req, {
            action: 'review_change',
            targetCollection: 'matches',
            targetId: String(doc.id),
            field: 'kickoff',
            fromStatus: previousDoc?.kickoff?.recordedAt ? 'recorded' : undefined,
            toStatus: 'recorded',
          })
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
          // Saving the kick-off sets the plan before the work starts: not a move, no email.
          const kickoffEdit = (req.context as KickoffContext | undefined)?.kickoffSave === doc.id
          const answered = kickoffEdit ? 0 : await resolveOpenReports(req, doc.id, 'date_moved')
          if (!kickoffEdit && (before || answered > 0)) {
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
      // The plan Konnected agreed at kick-off with the student and the company (lib/kickoff). The
      // dates are `startDate` and `endDate` above. Written by the team only (the collection's
      // update rule), and only while the project is matched (hook above). The student and the
      // company read it on their project page; the company only while the match runs. Nothing here
      // is the student's own data: the team writes it.
      name: 'kickoff',
      type: 'group',
      access: { create: adminOnlyField, update: adminOnlyField },
      fields: [
        { name: 'scope', label: 'Agreed scope', type: 'textarea', maxLength: KICKOFF_LIMITS.scope },
        {
          name: 'delivery',
          label: 'How to deliver',
          type: 'textarea',
          maxLength: KICKOFF_LIMITS.delivery,
        },
        {
          name: 'checkIns',
          label: 'Check-in dates',
          type: 'array',
          maxRows: KICKOFF_LIMITS.checkIns,
          fields: [{ name: 'day', type: 'date', required: true }],
        },
        {
          // The Konnected contact for this project. Team only: the others read the name below.
          name: 'contact',
          label: 'Konnected contact',
          type: 'relationship',
          relationTo: 'users',
          // No `filterOptions`: Payload would check it with the acting user's read access. The
          // hook checks that the contact is on the team.
          access: { read: adminOnlyField },
        },
        {
          // The contact's name, copied by the server when the kick-off is saved, so the student
          // and the company need no access to team users.
          name: 'contactName',
          type: 'text',
          admin: { readOnly: true },
        },
        {
          // When the kick-off was first recorded. Set by the server.
          name: 'recordedAt',
          type: 'date',
          admin: { readOnly: true },
        },
      ],
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
