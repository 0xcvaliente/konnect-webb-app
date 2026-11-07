/**
 * Feedback after a project (Kanban card "Feedback: collect after close and show to the team").
 * Plain values, types and pure rules only, so client components and the collection hook share
 * them.
 *
 * When a delivered project closes, the student and the company each get a short form, once:
 * overall 1 to 5, what went well, what could be better, and whether they would do it again. Only
 * the Konnected team reads the answers. Ratings on profiles come after launch (not built).
 */

export const FEEDBACK_SIDES = ['student', 'company'] as const
export type FeedbackSide = (typeof FEEDBACK_SIDES)[number]

export const RATING_MIN = 1
export const RATING_MAX = 5
export const FEEDBACK_TEXT_MAX = 2000

/** A whole number from 1 to 5. */
export const isRating = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX

/** Why feedback was refused. Each has its own message in both languages. */
export const FEEDBACK_ERRORS = [
  'forbidden',
  'not_found',
  /** The project is not closed after delivery: nothing to give feedback on yet. */
  'not_open',
  /** Feedback was given once already. */
  'already_sent',
  'rating_required',
  'too_long',
  'generic',
] as const
export type FeedbackError = (typeof FEEDBACK_ERRORS)[number]

export type FeedbackState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: FeedbackError; doneAt: number }

export const FEEDBACK_IDLE: FeedbackState = { status: 'idle' }

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function feedbackErrorCode(error: unknown): FeedbackError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (FEEDBACK_ERRORS as readonly string[]).includes(code))
      return code as FeedbackError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A text answer: trimmed, or null when empty. */
export const cleanText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.replace(/\r\n/g, '\n').trim()
  return text ? text : null
}
