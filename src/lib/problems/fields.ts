/**
 * Problem paths (Kanban cards "Problem reports: more time, match again, close without delivery"
 * and "Projects without a match: reopen, ask for changes, close"). Plain values, types and pure
 * rules only, so client components, the collection hooks and the team pages share them.
 *
 * A student tells Konnected "I need more time" or "I can't finish", with a note only the team
 * reads. The team then moves the due date (the old dates are kept on the match), ends the match and
 * reopens applications, or closes the project without delivery. A project nobody fits is reopened
 * with a new closing day, sent back to the company with what to change, or closed without a match.
 * The company sees the new plan, never the student's note.
 */

export const PROBLEM_KINDS = ['more_time', 'cannot_finish'] as const
export type ProblemKind = (typeof PROBLEM_KINDS)[number]

export const PROBLEM_STATUSES = ['open', 'resolved'] as const

/** How the team settled a report. `no_change`: the team talked to the student; nothing changes. */
export const PROBLEM_RESOLUTIONS = ['date_moved', 'match_ended', 'closed', 'no_change'] as const
export type ProblemResolution = (typeof PROBLEM_RESOLUTIONS)[number]

/** How a project was closed: the usual way, or by one of the problem paths. */
export const CLOSE_OUTCOMES = ['delivered', 'no_delivery', 'no_match'] as const
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number]

/** Why applications were opened again: the match ended, or nobody fitted the first time. */
export const REOPEN_REASONS = ['match_ended', 'no_match'] as const
export type ReopenReason = (typeof REOPEN_REASONS)[number]

/** Project statuses in which the student works on the project and may report a problem. */
export const REPORTABLE_PROJECT_STATUSES = ['matched', 'in_progress'] as const

export const PROBLEM_NOTE_MAX = 2000
export const REASON_MAX = 2000

/** Why a problem path was refused. Each has its own message in both languages. */
export const PROBLEM_ERRORS = [
  'forbidden',
  'not_found',
  /** The match ended or the project moved on: nothing to report or decide here now. */
  'not_open',
  /** A report from the student waits for the team already. */
  'already_open',
  'note_required',
  'note_too_long',
  'kind_required',
  /** A new due date or closing day must be today or later. */
  'date_invalid',
  /** The new due date is the one the match already has. */
  'date_same',
  /** Closing without delivery or without a match needs a reason (both parties get it). */
  'reason_required',
  'reason_too_long',
  /** Someone else acted first: load the page again. */
  'changed',
  'generic',
] as const
export type ProblemError = (typeof PROBLEM_ERRORS)[number]

export type ProblemState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: ProblemError; doneAt: number }

export const PROBLEM_IDLE: ProblemState = { status: 'idle' }

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function problemErrorCode(error: unknown): ProblemError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (PROBLEM_ERRORS as readonly string[]).includes(code))
      return code as ProblemError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A note or reason: trimmed, or null when empty. */
export const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text ? text : null
}
