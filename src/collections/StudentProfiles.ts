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
import { copyNameToUser } from '@/hooks/copyNameToUser'
import {
  logActivityAfterChange,
  logActivityAfterDelete,
  logReassignments,
  writeActivity,
} from '@/hooks/logActivity'
import { isAdminEmail } from '@/access/adminEmails'
import { sendProfileReviewEmail } from '@/lib/email/profileEmails'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import {
  canonical,
  changedFields,
  REVIEW_NOTE_MAX,
  REVIEW_STATUSES,
  REVIEWED_FIELDS,
  type ReviewSnapshot,
  reviewSnapshot,
  SHARE_KEYS,
} from '@/lib/students/fields'
import {
  assertTransition,
  PROFILE_REVIEW_TRANSITIONS,
  type ProfileReviewStatus,
} from '@/lib/transitions'

/** Fields copied to a match's `sharedInfo`. A change to any of them refreshes the copies. */
const SHARED_SOURCE_FIELDS = [
  'name',
  'school',
  'programme',
  'year',
  'pitch',
  'skills',
  'experience',
  'cv',
  'contactEmail',
  'phone',
  'privacy',
] as const

/**
 * ALL student personal data lives here and nowhere else. Admin reads everything. A student reads
 * and edits only their own profile. Companies get no access at all, so a populated relation at any
 * depth cannot leak anything from this collection. A selected student's agreed information reaches
 * the company as a copy on the match (see Matches), never through this collection.
 *
 * Every personal field also has field-level read access as a second layer.
 */
const personal = { read: adminOrStudentField }

export const StudentProfiles: CollectionConfig = {
  slug: 'student-profiles',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'school', 'programme'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { user: { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user)) return { user: { equals: user!.id } }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req }) => {
        // A student can only create a profile for themselves. The client cannot choose the user.
        if (operation === 'create' && isStudent(req.user)) {
          data.user = req.user!.id
        }

        // Review: only Konnected decides (PROFILE_REVIEW_TRANSITIONS). Field access already drops
        // a non-admin's review values; the rules below are the second layer and the moves the
        // server makes itself.
        const now = new Date().toISOString()
        const admin = isAdmin(req.user)
        if (operation === 'create') {
          if (!admin) {
            data.reviewStatus = 'waiting'
            data.reviewedAt = null
          }
          data.reviewStatus ??= 'waiting'
          // The review clock starts when the profile is sent (the onboarding's last step).
          data.reviewRequestedAt ??= now
        } else {
          const from = (originalDoc?.reviewStatus ?? 'waiting') as ProfileReviewStatus
          // Did this save change anything Konnected reviews? (`data` holds every field here.)
          const before = reviewSnapshot(originalDoc ?? {})
          const after = reviewSnapshot(data)
          const touched = REVIEWED_FIELDS.some(
            (key) => canonical(after[key]) !== canonical(before[key]),
          )
          if (!admin) {
            data.reviewStatus = from
            data.reviewedAt = originalDoc?.reviewedAt ?? null
            // Konnected asked for changes: the student's edit sends the profile back for review.
            if (from === 'changes_requested' && touched) {
              data.reviewStatus = 'waiting'
              data.reviewRequestedAt = now
            }
            // A reviewed profile stays reviewed when the student edits it; the team sees what
            // changed since the review (and since when).
            if (from === 'reviewed') {
              // A profile reviewed before snapshots existed: what it held until now is what was
              // reviewed, so that becomes the snapshot.
              const stored = (originalDoc?.reviewedSnapshot ?? null) as ReviewSnapshot | null
              const snapshot = stored ?? before
              if (!stored) data.reviewedSnapshot = snapshot
              const differs = changedFields(snapshot, { ...originalDoc, ...data }).length > 0
              data.changedSinceReviewAt = differs
                ? (originalDoc?.changedSinceReviewAt ?? now)
                : null
            }
          }
          const to = (data.reviewStatus ?? from) as ProfileReviewStatus
          assertTransition(PROFILE_REVIEW_TRANSITIONS, from, to, effectiveRole(req.user), 'Profile')

          if (admin) {
            if (to === 'waiting') data.reviewedAt = null
            if (to === 'changes_requested') {
              // The student must know what to change: a note comes with the request.
              const note = (data.reviewNote ?? '').trim()
              if (!note) throw new APIError('Profile: write what the student should change', 400)
              if (note.length > REVIEW_NOTE_MAX) {
                throw new APIError('Profile: the note is too long', 400)
              }
              data.reviewedAt = null
            }
            // Marking the profile reviewed (or reviewed again, with a new date) keeps a copy of
            // what was reviewed and closes the request for changes.
            const reviewedNow =
              to === 'reviewed' &&
              (from !== 'reviewed' ||
                (data.reviewedAt ?? null) !== (originalDoc?.reviewedAt ?? null))
            if (reviewedNow) {
              data.reviewedAt ??= now
              data.reviewedSnapshot = reviewSnapshot({ ...originalDoc, ...data })
              data.changedSinceReviewAt = null
              data.reviewNote = null
            }
            // A review decision on a profile nobody took from the shared pool: the team member
            // who decided takes it, so a later change by the student lands on their list.
            if ((reviewedNow || to === 'changes_requested') && !relationId(data.takenBy)) {
              data.takenBy = req.user!.id
            }
            // Bypass: the server reads the chosen user's role and address to check they are on
            // the team. Only the role and the address are used.
            const taker = relationId(data.takenBy)
            if (taker && taker !== relationId(originalDoc?.takenBy)) {
              const member = await req.payload.findByID({
                collection: 'users',
                id: taker,
                depth: 0,
                overrideAccess: true,
                disableErrors: true,
                req,
              })
              if (!member || member.role !== 'admin' || !isAdminEmail(member.email)) {
                throw new APIError('Profile: the person taking it must be on the team', 400)
              }
            }
          }
        }
        // The date of the team's note follows the note.
        if ((data.reviewNote ?? '') !== (originalDoc?.reviewNote ?? '')) {
          data.reviewNoteAt = data.reviewNote ? now : null
        }

        // The CV on a profile must be one the profile's student uploaded. Bypass: the server
        // reads the CV's owner, which the acting user may not be allowed to read.
        const cvId = relationId(data.cv)
        if (cvId && cvId !== relationId(originalDoc?.cv)) {
          const cv = await req.payload.findByID({
            collection: 'cvs',
            id: cvId,
            depth: 0,
            overrideAccess: true,
            disableErrors: true,
            req,
          })
          if (!cv || relationId(cv.owner) !== relationId(data.user ?? originalDoc?.user)) {
            throw new APIError('This CV does not belong to this student', 403)
          }
        }
        return data
      },
    ],
    afterChange: [
      logReassignments(['takenBy']),
      logActivityAfterChange({ statusField: 'reviewStatus' }),
      async ({ doc, previousDoc, operation, req, context }) => {
        if (operation !== 'update') return doc
        const from = previousDoc?.reviewStatus ?? 'waiting'
        // Reviewed again after the student changed it: a decision, but not a status change.
        if (
          !context?.skipActivityLog &&
          isAdmin(req.user) &&
          from === 'reviewed' &&
          doc.reviewStatus === 'reviewed' &&
          (doc.reviewedAt ?? null) !== (previousDoc?.reviewedAt ?? null)
        ) {
          await writeActivity(req, {
            action: 'review_change',
            targetCollection: 'student-profiles',
            targetId: String(doc.id),
            field: 'reviewedAt',
            toStatus: 'reviewed',
          })
        }
        // Tell the student: reviewed, or what Konnected asks them to change.
        if (doc.reviewStatus !== from) {
          if (doc.reviewStatus === 'reviewed' || doc.reviewStatus === 'changes_requested') {
            await sendProfileReviewEmail(req, doc, doc.reviewStatus)
          }
        }
        return doc
      },
      copyNameToUser('name'),
      async ({ doc, previousDoc, operation, req }) => {
        // Keep what companies see in step with what the student shares now: ticking "share my
        // CV" after selection shares it, unticking stops it. Bypass: the server rebuilds the
        // copy on each of this student's matches (see Matches); the student cannot edit matches.
        if (operation !== 'update') return doc
        const changed = SHARED_SOURCE_FIELDS.some(
          (key) => JSON.stringify(doc[key] ?? null) !== JSON.stringify(previousDoc?.[key] ?? null),
        )
        if (!changed) return doc
        // Matches Konnected ended keep no copy, and stay as they are.
        const matches = await req.payload.find({
          collection: 'matches',
          where: { and: [{ student: { equals: doc.id } }, ACTIVE_MATCH] },
          depth: 0,
          pagination: false,
          overrideAccess: true,
          req,
        })
        for (const match of matches.docs) {
          await req.payload.update({
            collection: 'matches',
            id: match.id,
            data: {},
            overrideAccess: true,
            req,
          })
        }
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'user',
      type: 'relationship',
      relationTo: 'users',
      required: true,
      unique: true,
      index: true,
      access: { read: adminOrStudentField, update: adminOnlyField },
    },
    { name: 'name', type: 'text', required: true, access: personal },
    { name: 'school', type: 'text', access: personal },
    { name: 'programme', type: 'text', access: personal },
    { name: 'year', type: 'number', min: 1, max: 10, access: personal },
    { name: 'pitch', type: 'textarea', access: personal },
    { name: 'skills', type: 'text', hasMany: true, access: personal },
    { name: 'interests', type: 'text', hasMany: true, access: personal },
    { name: 'experience', type: 'textarea', access: personal },
    { name: 'highlights', type: 'textarea', access: personal },
    { name: 'preferredProjectTypes', type: 'text', hasMany: true, access: personal },
    {
      // The student's current CV (see the `cvs` collection: PDF only, 10 MB, private).
      name: 'cv',
      type: 'upload',
      relationTo: 'cvs',
      access: personal,
      // Admin panel helper only. The hook above is the real check.
      filterOptions: ({ data }) => ({ owner: { equals: relationId(data?.user) ?? 0 } }),
    },
    { name: 'contactEmail', type: 'email', access: personal },
    { name: 'phone', type: 'text', access: personal },
    {
      // What the student agrees to share with a company after Konnected selects them.
      // Nothing is shared by default. `shareSchool` covers school, programme and year.
      name: 'privacy',
      type: 'group',
      access: personal,
      fields: SHARE_KEYS.map((name) => ({ name, type: 'checkbox' as const, defaultValue: false })),
    },
    {
      // Konnected's review of the profile. Every profile starts `waiting`; only an admin moves it.
      // The student reads it (to see "We review profiles within 2 working days" or the date).
      name: 'reviewStatus',
      type: 'select',
      // Not `required`, so creating a profile does not have to name it: the default and the hook
      // above always set it. A missing value reads as `waiting`.
      defaultValue: 'waiting',
      options: [...REVIEW_STATUSES],
      index: true,
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // When Konnected reviewed the profile. Set by the hook above when the status moves to
      // `reviewed`; an admin may correct it.
      name: 'reviewedAt',
      type: 'date',
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // What Konnected asks the student to change. The student reads it on their profile and gets
      // it by email. Cleared when the profile is marked reviewed.
      name: 'reviewNote',
      label: 'What to change (note to the student)',
      type: 'textarea',
      maxLength: REVIEW_NOTE_MAX,
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
    },
    {
      name: 'reviewNoteAt',
      label: 'Note written',
      type: 'date',
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // When the profile was last sent for review (created, or updated after Konnected asked for
      // changes). The 2 working day promise counts from here. Set by the server.
      name: 'reviewRequestedAt',
      label: 'Waiting for review since',
      type: 'date',
      access: { read: adminOrStudentField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // The student changed a reviewed profile: since when. The profile stays reviewed; the team
      // sees it in the queue with what changed. Cleared when the team reviews it again.
      name: 'changedSinceReviewAt',
      label: 'Changed since the review',
      type: 'date',
      index: true,
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, position: 'sidebar' },
    },
    {
      // Who on the team took the profile from the shared pool to review it ("Take it"), or made
      // the first review decision. Later changes by the student land on their list. Team only;
      // never personal data of the student.
      name: 'takenBy',
      label: 'Taken from the pool by',
      type: 'relationship',
      relationTo: 'users',
      index: true,
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { position: 'sidebar' },
    },
    {
      // A copy of the reviewed fields at the last review, to show the team what changed since.
      // Team only. Set by the server.
      name: 'reviewedSnapshot',
      type: 'json',
      access: { read: adminOnlyField, create: adminOnlyField, update: adminOnlyField },
      admin: { readOnly: true, hidden: true },
    },
  ],
}
