import { type Payload, ValidationError } from 'payload'

import { companyIdOf, isCompany, relationId } from '@/access/roles'
import type { BriefFile, Match, Project, User } from '@/payload-types'

import {
  COMPANY_EDITABLE,
  PROJECT_FIELD_PROBLEMS,
  PROJECT_FIELDS,
  type ProjectData,
  type ProjectField,
  type ProjectFieldErrors,
  type ProjectFieldProblem,
  type ProjectFormState,
  problemsForReview,
  readProjectInput,
} from './fields'

/**
 * The company's own projects: the form's draft saves, sending for review, and the reads behind the
 * "My projects" list and the project page. Plain functions over Payload so they can be tested
 * without a request; the Server Actions in actions.ts call them with the signed-in user.
 *
 * Every read and write goes through the Local API as that user with `overrideAccess: false`, so
 * the collection's access rules and hooks decide: only a company user, only its own company's
 * projects, only while a project is a draft or changes were requested, only an approved company
 * sends for review, and never the status, the price or Konnected's note. The checks here come
 * first only to give clear answers. Nothing here logs form values.
 */

export type SessionUser = User & { collection: 'users' }

type Result = ProjectFormState

const fail = (error: NonNullable<Result['error']>, id?: number): Result => ({
  status: 'error',
  error,
  id,
})
const invalid = (fields: ProjectFieldErrors, id?: number): Result => ({
  status: 'error',
  fields,
  id,
})

const isEditable = (status: Project['status']) =>
  (COMPANY_EDITABLE as readonly string[]).includes(status)

/** The signed-in company user's own project, read as that user. Null when it is not theirs. */
export async function findOwnProject(
  payload: Payload,
  user: SessionUser,
  id: number,
  depth = 0,
): Promise<Project | null> {
  if (!isCompany(user) || !companyIdOf(user) || !Number.isInteger(id) || id <= 0) return null
  const found = await payload.find({
    collection: 'projects',
    where: { id: { equals: id } },
    limit: 1,
    depth,
    user,
    overrideAccess: false,
  })
  return found.docs[0] ?? null
}

/** Every project of the signed-in company user's company, newest change first. */
export async function listOwnProjects(payload: Payload, user: SessionUser): Promise<Project[]> {
  if (!isCompany(user) || !companyIdOf(user)) return []
  const found = await payload.find({
    collection: 'projects',
    sort: '-updatedAt',
    depth: 0,
    pagination: false,
    user,
    overrideAccess: false,
  })
  return found.docs
}

export type HistoryEntry = { status: string; at: string; created: boolean }

/**
 * The status changes of one of the company's own projects, oldest first, for the timeline on the
 * project page. The caller must have read the project as the company user first.
 *
 * Bypass: the activity log is admin-only, so the server reads it with `overrideAccess: true`. Only
 * the new status and the time leave this function: never who made the change or the team's
 * internal notes.
 */
export async function projectHistory(payload: Payload, projectId: number): Promise<HistoryEntry[]> {
  const rows = await payload.find({
    collection: 'activity-logs',
    where: {
      and: [
        { targetCollection: { equals: 'projects' } },
        { targetId: { equals: String(projectId) } },
        { action: { in: ['create', 'status_change'] } },
      ],
    },
    sort: 'createdAt',
    depth: 0,
    pagination: false,
    select: { action: true, toStatus: true, createdAt: true },
    overrideAccess: true,
  })
  return rows.docs.map((row) => ({
    status: row.toStatus ?? 'draft',
    at: row.createdAt,
    created: row.action === 'create',
  }))
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

/**
 * A save Payload refused, as an answer for the page. A Server Action that throws sends the user
 * to an error page and loses every unsaved edit, so it never does. The log line has no values.
 */
function refused(payload: Payload, error: unknown, id?: number): Result {
  if (error instanceof ValidationError) {
    const fields: ProjectFieldErrors = {}
    for (const { path, message } of error.data.errors) {
      if ((PROJECT_FIELDS as readonly string[]).includes(path)) {
        fields[path as ProjectField] = (PROJECT_FIELD_PROBLEMS as readonly string[]).includes(
          message,
        )
          ? (message as ProjectFieldProblem)
          : 'invalid'
      }
    }
    if (Object.keys(fields).length) return invalid(fields, id)
  }
  const status = statusOf(error)
  if (status === 403 && /approved/i.test(error instanceof Error ? error.message : ''))
    return fail('not_approved', id)
  if (status === 403 && /attachment/i.test(error instanceof Error ? error.message : ''))
    return invalid({ attachments: 'invalid' }, id)
  if (status === 403 || status === 404) return fail('not_editable', id)
  payload.logger.error({
    msg: 'Project save failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic', id)
}

/** Remove brief files the company took off its project. Best effort: the clean-up job does the rest. */
async function removeFiles(payload: Payload, user: SessionUser, ids: number[]) {
  for (const id of ids) {
    try {
      await payload.delete({ collection: 'brief-files', id, user, overrideAccess: false })
    } catch {
      // Not removable now (for example on another project Konnected reviewed). Left for clean-up.
    }
  }
}

const idOf = (value: unknown): number | undefined => {
  const id = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** Create the draft, or save it again (and send it, with `status`). Returns the project's id. */
async function write(
  payload: Payload,
  user: SessionUser,
  id: number | undefined,
  data: ProjectData,
  status?: 'submitted',
): Promise<{ id: number } | Result> {
  let previous: number[] = []
  if (id) {
    const existing = await findOwnProject(payload, user, id)
    if (!existing) return fail('not_found')
    if (!isEditable(existing.status)) return fail('not_editable', id)
    previous = (existing.attachments ?? [])
      .map((a) => relationId(a as number | BriefFile))
      .filter((a): a is number => Boolean(a))
  }
  let saved: Project | undefined
  try {
    saved = id
      ? await payload.update({
          collection: 'projects',
          id,
          data: { ...data, ...(status ? { status } : {}) },
          user,
          overrideAccess: false,
        })
      : await payload.create({
          collection: 'projects',
          // The collection makes every new project a draft of the user's own company.
          data: { ...data, status: 'draft' } as Omit<Project, 'id' | 'createdAt' | 'updatedAt'>,
          user,
          overrideAccess: false,
        })
    if (!id && status) {
      saved = await payload.update({
        collection: 'projects',
        id: saved.id,
        data: { status },
        user,
        overrideAccess: false,
      })
    }
  } catch (error) {
    return refused(payload, error, saved?.id ?? id)
  }
  const removed = previous.filter((p) => !data.attachments.includes(p))
  if (removed.length) await removeFiles(payload, user, removed)
  return { id: saved.id }
}

/** The form's auto-save and "Save draft": creates the draft the first time, then saves it. */
export async function saveProjectDraft(
  payload: Payload,
  user: SessionUser | null,
  id: unknown,
  input: unknown,
): Promise<Result> {
  if (!user || !isCompany(user) || !companyIdOf(user)) return fail('forbidden')
  const projectId = idOf(id)
  const errors: ProjectFieldErrors = {}
  const { data } = readProjectInput(input, errors)
  if (Object.keys(errors).length) return invalid(errors, projectId)
  const result = await write(payload, user, projectId, data)
  if ('status' in result) return result
  return { status: 'saved', id: result.id }
}

/**
 * "Send for review": save the form and move the project to `submitted` in one change. Only an
 * approved company, only a complete project. The collection hook checks both again for every API.
 * When something is missing, what was typed is still saved as a draft.
 */
export async function sendProjectForReview(
  payload: Payload,
  user: SessionUser | null,
  id: unknown,
  input: unknown,
): Promise<Result> {
  if (!user || !isCompany(user) || !companyIdOf(user)) return fail('forbidden')
  let projectId = idOf(id)
  const errors: ProjectFieldErrors = {}
  const { data, days } = readProjectInput(input, errors)
  if (Object.keys(errors).length) return invalid(errors, projectId)

  const problems = problemsForReview({ ...data, ...days })
  if (Object.keys(problems).length) {
    const draft = await write(payload, user, projectId, data)
    if ('status' in draft) return draft
    return invalid(problems, draft.id)
  }

  // A clear answer for a company Konnected has not approved yet, read as the user (no bypass).
  const company = await payload.findByID({
    collection: 'companies',
    id: companyIdOf(user)!,
    depth: 0,
    select: { status: true },
    user,
    overrideAccess: false,
    disableErrors: true,
  })
  if (company?.status !== 'approved') {
    const draft = await write(payload, user, projectId, data)
    if ('status' in draft) return draft
    return fail('not_approved', draft.id)
  }

  const result = await write(payload, user, projectId, data, 'submitted')
  if ('status' in result) return result
  projectId = result.id
  return { status: 'sent', id: projectId }
}

/** What the company sees about its selected student: the match's shared copy, nothing else. */
export type SelectedStudent = {
  /** When Konnected selected the student. */
  selectedAt: string
  shared: NonNullable<Match['sharedInfo']>
  /** The CV, when the student shares it (the file route checks the same tick on every request). */
  cv: { url: string; name: string } | null
}

/**
 * The selected student of one of the company user's own projects, read as that user with access
 * control on: the match's `student` and `application` relations are not readable for a company,
 * so only the shared copy comes back. Null for anyone else, and before Konnected selects someone.
 * The caller must have read the project as the company user first.
 */
export async function findSelectedStudent(
  payload: Payload,
  user: SessionUser,
  projectId: number,
): Promise<SelectedStudent | null> {
  if (!isCompany(user) || !companyIdOf(user)) return null
  const found = await payload.find({
    collection: 'matches',
    where: { project: { equals: projectId } },
    limit: 1,
    depth: 1,
    user,
    overrideAccess: false,
  })
  const match = found.docs[0]
  if (!match?.sharedInfo) return null
  const cv =
    typeof match.sharedInfo.cv === 'object' && match.sharedInfo.cv ? match.sharedInfo.cv : null
  return {
    selectedAt: match.createdAt,
    shared: { ...match.sharedInfo, cv: cv?.id ?? null },
    cv: cv?.url ? { url: cv.url, name: cv.originalName ?? cv.filename ?? 'CV.pdf' } : null,
  }
}
