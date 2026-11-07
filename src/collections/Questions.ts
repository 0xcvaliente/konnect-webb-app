import { APIError, type CollectionConfig, type PayloadRequest, type Where } from 'payload'

import {
  adminOnlyField,
  adminOrStudentField,
  companyIdOf,
  isAdmin,
  isCompany,
  isStudent,
  relationId,
} from '@/access/roles'
import { logActivityAfterChange, logActivityAfterDelete } from '@/hooks/logActivity'
import { lockRow } from '@/lib/db/locks'
import { sendAnswerEmail, sendRelayEmail } from '@/lib/email/questionEmails'
import { ACTIVE_MATCH } from '@/lib/problems/rules'
import {
  ANSWER_MAX,
  cleanText,
  OPEN_LIMIT,
  otherSide,
  QUESTION_KINDS,
  QUESTION_MAX,
  QUESTION_SIDES,
  QUESTION_STATUSES,
  type QuestionError,
  type QuestionSide,
} from '@/lib/questions/fields'

type Rel = number | { id: number } | null | undefined

/** Context keys the server sets. A client cannot set `req.context` through any API. */
export type QuestionContext = {
  /** The reminder job stamps `reminderSentAt` and nothing else. */
  questionReminder?: boolean
}

export const questionError = (code: QuestionError, message: string, status = 400): APIError =>
  new APIError(message, status, { code }, true)

/** The user behind a student profile. Bypass: only the id is read. */
async function userOfProfile(req: PayloadRequest, profileId: number | undefined) {
  if (!profileId) return undefined
  const profile = await req.payload.findByID({
    collection: 'student-profiles',
    id: profileId,
    depth: 0,
    select: { user: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return relationId(profile?.user as Rel)
}

/** The company's one user. Bypass: only the id is read. */
async function userOfCompany(req: PayloadRequest, companyId: number | undefined) {
  if (!companyId) return undefined
  const company = await req.payload.findByID({
    collection: 'companies',
    id: companyId,
    depth: 0,
    select: { user: true },
    overrideAccess: true,
    disableErrors: true,
    req,
  })
  return relationId(company?.user as Rel)
}

/** At most a few open questions per person and project, so the queue stays readable. */
async function assertUnderLimit(req: PayloadRequest, projectId: number, userId: number) {
  // One ask at a time per project: two sends at once run one after the other.
  await lockRow(req, 'projects', projectId)
  const open = await req.payload.count({
    collection: 'questions',
    where: {
      and: [
        { project: { equals: projectId } },
        { recipient: { equals: userId } },
        { kind: { equals: 'ask' } },
        { status: { equals: 'open' } },
      ],
    },
    overrideAccess: true,
    req,
  })
  if (open.totalDocs >= OPEN_LIMIT) {
    throw questionError('too_many', 'Wait for Konnected to answer your open questions', 409)
  }
}

const firstNameOf = (name: unknown, email: unknown): string => {
  const text = typeof name === 'string' && name.trim() ? name.trim() : String(email ?? '')
  return text.split(/[\s@]/)[0] ?? ''
}

/**
 * Ask Konnected (lib/questions/fields.ts): a student's question about their application, a
 * company's about its project, and Konnected's relays of a question to the other side.
 *
 * Read: admins all; anyone else only the rows addressed to them (`recipient`): their own questions
 * with Konnected's answers, and the relays Konnected sent them. A company never reads a student's
 * question and a student never reads a company's; what passes between the sides is what the team
 * wrote in a relay. Create: a student (about their own application), a company (about its own
 * project), or the team (a relay of an existing question). The asker, the recipient, the project
 * and the side come from the session and the stored records, never from the request. Update: the
 * team answers a question once; the recipient of a relay answers it once; nothing else changes.
 * Delete: admins.
 */
export const Questions: CollectionConfig = {
  slug: 'questions',
  admin: { defaultColumns: ['project', 'kind', 'side', 'status', 'createdAt'] },
  access: {
    read: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user) || isCompany(user)) return { recipient: { equals: user!.id } }
      return false
    },
    create: ({ req: { user } }) => isAdmin(user) || isStudent(user) || isCompany(user),
    update: ({ req: { user } }): Where | boolean => {
      if (isAdmin(user)) return true
      if (isStudent(user) || isCompany(user)) {
        return {
          and: [
            { recipient: { equals: user!.id } },
            { kind: { equals: 'relay' } },
            { status: { equals: 'open' } },
          ],
        }
      }
      return false
    },
    delete: ({ req: { user } }) => isAdmin(user),
  },
  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req, context }) => {
        const user = req.user
        if (operation === 'create') {
          if (data.status !== undefined && data.status !== 'open') {
            throw new APIError('A new question starts open', 400)
          }
          const body = cleanText(data.body)
          if (!body) throw questionError('text_required', 'Write the question', 400)
          if (body.length > QUESTION_MAX)
            throw questionError('too_long', 'The question is too long')
          const base = {
            body,
            status: 'open' as const,
            answer: null,
            answeredBy: null,
            answeredByName: null,
            answeredAt: null,
            reminderSentAt: null,
          }

          if (isAdmin(user)) {
            // The team passes a question on to the other side, in its own words.
            const originalId = relationId(data.relayOf as Rel)
            const original = originalId
              ? await req.payload.findByID({
                  collection: 'questions',
                  id: originalId,
                  depth: 0,
                  overrideAccess: true,
                  disableErrors: true,
                  req,
                })
              : null
            if (!original || original.kind !== 'ask') {
              throw questionError('not_found', 'A relay passes on an existing question', 404)
            }
            const projectId = relationId(original.project as Rel)!
            const side = otherSide(original.side as QuestionSide)
            let recipient: number | undefined
            let application: number | null = null
            // Bypass for the reads below: the server finds the other side's one user.
            const project = await req.payload.findByID({
              collection: 'projects',
              id: projectId,
              depth: 0,
              select: { company: true },
              overrideAccess: true,
              disableErrors: true,
              req,
            })
            if (side === 'company') {
              recipient = await userOfCompany(req, relationId(project?.company as Rel))
            } else {
              // The student Konnected selected and whose match runs: nobody else on the project.
              const found = await req.payload.find({
                collection: 'matches',
                where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
                limit: 1,
                depth: 0,
                select: { student: true, application: true },
                overrideAccess: true,
                req,
              })
              const match = found.docs[0]
              recipient = await userOfProfile(req, relationId(match?.student as Rel))
              application = relationId(match?.application as Rel) ?? null
            }
            if (!recipient) {
              throw questionError('no_recipient', 'Nobody on the other side to ask yet', 409)
            }
            return {
              ...base,
              kind: 'relay',
              project: projectId,
              application,
              side,
              askedBy: user!.id,
              recipient,
              relayOf: original.id,
            }
          }

          if (isStudent(user)) {
            // About the student's own application; the project comes from it.
            const applicationId = relationId(data.application as Rel)
            const application = applicationId
              ? await req.payload.findByID({
                  collection: 'applications',
                  id: applicationId,
                  depth: 0,
                  select: { student: true, project: true },
                  overrideAccess: true,
                  disableErrors: true,
                  req,
                })
              : null
            const owner = await userOfProfile(req, relationId(application?.student as Rel))
            const projectId = relationId(application?.project as Rel)
            if (!application || !projectId || owner !== user!.id) {
              throw questionError('not_found', 'This application is not yours', 404)
            }
            await assertUnderLimit(req, projectId, user!.id)
            return {
              ...base,
              kind: 'ask',
              project: projectId,
              application: application.id,
              side: 'student',
              askedBy: user!.id,
              recipient: user!.id,
              relayOf: null,
            }
          }

          if (isCompany(user)) {
            const projectId = relationId(data.project as Rel)
            const project = projectId
              ? await req.payload.findByID({
                  collection: 'projects',
                  id: projectId,
                  depth: 0,
                  select: { company: true },
                  overrideAccess: true,
                  disableErrors: true,
                  req,
                })
              : null
            const companyId = companyIdOf(user)
            if (!project || !companyId || relationId(project.company as Rel) !== companyId) {
              throw questionError('not_found', 'This project is not yours', 404)
            }
            await assertUnderLimit(req, project.id, user!.id)
            return {
              ...base,
              kind: 'ask',
              project: project.id,
              application: null,
              side: 'company',
              askedBy: user!.id,
              recipient: user!.id,
              relayOf: null,
            }
          }
          throw questionError('forbidden', 'Only students, companies and the team ask', 403)
        }

        // Update. Everything the asker wrote, and who it is for, stays as stored.
        const kept = {
          kind: originalDoc?.kind,
          project: originalDoc?.project,
          application: originalDoc?.application,
          side: originalDoc?.side,
          askedBy: originalDoc?.askedBy,
          recipient: originalDoc?.recipient,
          relayOf: originalDoc?.relayOf,
          body: originalDoc?.body,
        }
        if ((context as QuestionContext | undefined)?.questionReminder) {
          // The reminder job: only the stamp.
          return {
            ...data,
            ...kept,
            reminderSentAt: data.reminderSentAt ?? originalDoc?.reminderSentAt ?? null,
          }
        }
        const from = originalDoc?.status
        const to = data.status ?? from
        if (from === to) {
          // An answer goes with the move to answered, once. A later answer is refused.
          const sent = cleanText(data.answer)
          if (sent && sent !== (originalDoc?.answer ?? null)) {
            throw questionError('not_open', 'This question was answered already', 409)
          }
          // Nothing moves except an admin's own fix of the reminder stamp: the answer is final.
          return {
            ...data,
            ...kept,
            status: from,
            answer: originalDoc?.answer ?? null,
            answeredBy: originalDoc?.answeredBy ?? null,
            answeredByName: originalDoc?.answeredByName ?? null,
            answeredAt: originalDoc?.answeredAt ?? null,
            reminderSentAt: isAdmin(user)
              ? (data.reminderSentAt ?? originalDoc?.reminderSentAt ?? null)
              : (originalDoc?.reminderSentAt ?? null),
          }
        }
        if (from !== 'open' || to !== 'answered') {
          throw questionError('not_open', 'A question moves from open to answered once', 409)
        }
        const relay = originalDoc?.kind === 'relay'
        const mayAnswer = relay
          ? isAdmin(user) || relationId(originalDoc?.recipient as Rel) === user?.id
          : isAdmin(user)
        if (!mayAnswer) throw questionError('forbidden', 'Not yours to answer', 403)
        const answer = cleanText(data.answer)
        if (!answer) throw questionError('text_required', 'Write the answer', 400)
        if (answer.length > ANSWER_MAX) throw questionError('too_long', 'The answer is too long')
        return {
          ...data,
          ...kept,
          status: 'answered',
          answer,
          answeredBy: user!.id,
          // The asker reads the team member's first name with the answer ("Amanda answered").
          answeredByName: isAdmin(user) ? firstNameOf(user!.name, user!.email) : null,
          answeredAt: new Date().toISOString(),
          reminderSentAt: originalDoc?.reminderSentAt ?? null,
        }
      },
    ],
    afterChange: [
      logActivityAfterChange({ statusField: 'status' }),
      async ({ doc, previousDoc, operation, req, context }) => {
        if ((context as QuestionContext | undefined)?.questionReminder) return doc
        if (operation === 'create' && doc.kind === 'relay') await sendRelayEmail(req, doc)
        if (
          operation === 'update' &&
          doc.kind === 'ask' &&
          previousDoc?.status === 'open' &&
          doc.status === 'answered'
        ) {
          await sendAnswerEmail(req, doc)
        }
        return doc
      },
    ],
    afterDelete: [logActivityAfterDelete()],
  },
  fields: [
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'ask',
      index: true,
      options: [...QUESTION_KINDS],
    },
    {
      // Copied from the application (student) or checked against the company (company), or from
      // the question a relay passes on. Every save overwrites it with the stored value.
      name: 'project',
      type: 'relationship',
      relationTo: 'projects',
      index: true,
    },
    {
      // The student's own application (a student's question, or a relay to the selected
      // student). Never read by a company.
      name: 'application',
      type: 'relationship',
      relationTo: 'applications',
      index: true,
      access: { read: adminOrStudentField },
    },
    {
      // Who the row is for: the asker of a question, the recipient of a relay.
      name: 'side',
      type: 'select',
      options: [...QUESTION_SIDES],
    },
    {
      // Who wrote it: the asker, or the team member who relayed. Team only.
      name: 'askedBy',
      type: 'relationship',
      relationTo: 'users',
      access: { read: adminOnlyField },
    },
    {
      // Who reads the row besides the team. Set by the server.
      name: 'recipient',
      type: 'relationship',
      relationTo: 'users',
      index: true,
    },
    {
      // The question a relay passes on. Team only (it points at the other side's question).
      name: 'relayOf',
      type: 'relationship',
      relationTo: 'questions',
      index: true,
      access: { read: adminOnlyField },
    },
    {
      name: 'body',
      label: 'Question',
      type: 'textarea',
      required: true,
      maxLength: QUESTION_MAX,
    },
    {
      name: 'status',
      type: 'select',
      required: true,
      defaultValue: 'open',
      index: true,
      options: [...QUESTION_STATUSES],
    },
    { name: 'answer', type: 'textarea', maxLength: ANSWER_MAX },
    {
      name: 'answeredBy',
      type: 'relationship',
      relationTo: 'users',
      access: { read: adminOnlyField },
    },
    {
      // The team member's first name, shown with the answer. Set by the server.
      name: 'answeredByName',
      type: 'text',
      maxLength: 80,
    },
    { name: 'answeredAt', type: 'date', index: true },
    {
      // When the owner was reminded that the answer is due. Set by the reminder job; team only.
      name: 'reminderSentAt',
      type: 'date',
      access: { read: adminOnlyField },
    },
  ],
}
