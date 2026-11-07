import type { Payload } from 'payload'

import { isStudent } from '@/access/roles'
import { storedToDay } from '@/lib/projects/fields'
import type { SessionUser } from '@/lib/students/profile'
import type { Match } from '@/payload-types'

import {
  cleanText,
  type ProblemError,
  problemErrorCode,
  type ProblemKind,
  PROBLEM_KINDS,
  PROBLEM_NOTE_MAX,
  type ProblemState,
  REPORTABLE_PROJECT_STATUSES,
} from './fields'
import { ACTIVE_MATCH } from './rules'

/**
 * The student's side of problem reports: what the card on the application page shows, and sending
 * a report. Every read and write runs as the student with `overrideAccess: false`; the
 * ProblemReports hook checks the match is theirs and running, and one report at a time.
 */

const asStudent = (user: SessionUser) => ({ user, overrideAccess: false as const })

export type StudentProblem = {
  matchId: number
  /** The due date agreed with Konnected (`YYYY-MM-DD`), or null before kick-off. */
  dueDay: string | null
  /** The earlier due dates, oldest first (`YYYY-MM-DD`). */
  movedFrom: string[]
  /** The work runs (matched or in progress): the student may tell Konnected about a problem. */
  canReport: boolean
  /** The student's report waiting for the team, if any. */
  open: { kind: ProblemKind; createdAt: string } | null
}

/** The problem card for one of the student's own projects. Null when there is no running match. */
export async function loadStudentProblem(
  payload: Payload,
  user: SessionUser | null,
  projectId: number | null,
): Promise<StudentProblem | null> {
  if (!user || !isStudent(user) || !projectId) return null
  const found = await payload.find({
    collection: 'matches',
    where: { and: [{ project: { equals: projectId } }, ACTIVE_MATCH] },
    limit: 1,
    depth: 0,
    ...asStudent(user),
  })
  const match = found.docs[0] as Match | undefined
  if (!match) return null
  // Bypass: a student reads published projects only, and this one is matched or later. The
  // student's own match was read above with access control on; only the status is read here.
  const project = await payload.findByID({
    collection: 'projects',
    id: projectId,
    depth: 0,
    select: { status: true },
    overrideAccess: true,
    disableErrors: true,
  })
  const open = await payload.find({
    collection: 'problem-reports',
    where: { and: [{ match: { equals: match.id } }, { status: { equals: 'open' } }] },
    limit: 1,
    depth: 0,
    select: { kind: true, createdAt: true },
    ...asStudent(user),
  })
  const report = open.docs[0]
  return {
    matchId: match.id,
    dueDay: storedToDay(match.endDate),
    movedFrom: (match.dueDateHistory ?? [])
      .map((h) => storedToDay(h.from))
      .filter((d): d is string => Boolean(d)),
    canReport: (REPORTABLE_PROJECT_STATUSES as readonly string[]).includes(project?.status ?? ''),
    open: report ? { kind: report.kind as ProblemKind, createdAt: report.createdAt } : null,
  }
}

const fail = (error: ProblemError): ProblemState => ({ status: 'error', error, doneAt: Date.now() })

/**
 * Tell Konnected "I need more time" or "I can't finish", with a note. The form carries the
 * project id, the kind and the note; the match is the student's own running one, found here as
 * the student. The hook checks everything again.
 */
export async function reportProblem(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<ProblemState> {
  if (!user || !isStudent(user)) return fail('forbidden')
  const raw = form.get('projectId')
  const projectId = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
  if (!projectId) return fail('not_found')
  const kind = form.get('kind')
  if (typeof kind !== 'string' || !(PROBLEM_KINDS as readonly string[]).includes(kind))
    return fail('kind_required')
  const note = cleanText(form.get('note'))
  if (!note) return fail('note_required')
  if (note.length > PROBLEM_NOTE_MAX) return fail('note_too_long')
  const state = await loadStudentProblem(payload, user, projectId)
  if (!state || !state.canReport) return fail('not_open')
  if (state.open) return fail('already_open')
  try {
    await payload.create({
      collection: 'problem-reports',
      data: { match: state.matchId, kind: kind as ProblemKind, note } as never,
      ...asStudent(user),
    })
  } catch (error) {
    const code = problemErrorCode(error)
    if (code) return fail(code)
    payload.logger.error({
      msg: 'Problem report failed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return fail('generic')
  }
  return { status: 'done', doneAt: Date.now() }
}
