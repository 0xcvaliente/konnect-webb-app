/**
 * Ask Konnected (Kanban card "Ask Konnected: questions and answers"). Plain values, types and pure
 * rules only, so client components, the collection hook and the team pages share them.
 *
 * Not messaging: a student asks Konnected about their application, a company about its project.
 * The question lands with the project's owner on the team (or the shared pool), and Konnected
 * promises an answer within 2 working days. The team answers (the asker gets the answer by email
 * and in the app), may pass a question on to the other side in its own words ("relay": one
 * question from Konnected that the other side answers once), and keeps saved answers for the
 * questions that come back. Only the asker and the team read a question; only the recipient and
 * the team read a relay.
 */

/** `ask`: from a student or a company to Konnected. `relay`: from Konnected to the other side. */
export const QUESTION_KINDS = ['ask', 'relay'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export const QUESTION_STATUSES = ['open', 'answered'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

/** Who asked (or, for a relay, who it went to). */
export const QUESTION_SIDES = ['student', 'company'] as const
export type QuestionSide = (typeof QUESTION_SIDES)[number]

/** Konnected promises an answer within this many working days (owner decision, 6 Nov 2026). */
export const ANSWER_DAYS = 2

export const QUESTION_MAX = 2000
export const ANSWER_MAX = 4000
export const SAVED_TITLE_MAX = 80

/** Open questions one person may have on one project at a time. */
export const OPEN_LIMIT = 3

/** Why a question action was refused. Each has its own message in both languages. */
export const QUESTION_ERRORS = [
  'forbidden',
  'not_found',
  /** The question was answered already (or the relay is closed): load the page again. */
  'not_open',
  'text_required',
  'too_long',
  /** Three open questions on this project already. */
  'too_many',
  /** Nobody on the other side to pass the question to (no student selected yet). */
  'no_recipient',
  'generic',
] as const
export type QuestionError = (typeof QUESTION_ERRORS)[number]

export type QuestionState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: QuestionError; doneAt: number }

export const QUESTION_IDLE: QuestionState = { status: 'idle' }

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function questionErrorCode(error: unknown): QuestionError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (QUESTION_ERRORS as readonly string[]).includes(code))
      return code as QuestionError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A question or answer as typed: trimmed, or null when empty. */
export const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n/g, '\n').trim()
  return text ? text : null
}

/** The other side of a question: a student's question is relayed to the company, and back. */
export const otherSide = (side: QuestionSide): QuestionSide =>
  side === 'student' ? 'company' : 'student'
