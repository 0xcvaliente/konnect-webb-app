/**
 * Shared shapes for the team's account screens. No server imports, so client components can use
 * them too.
 */

export const ACCOUNT_FILTERS = ['all', 'student', 'company', 'pending', 'admin', 'paused'] as const
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number]

export const PAGE_SIZE = 25

/** The longest pause reason the team can write. Matches `activity-logs.note`. */
export const REASON_MAX = 500

export type AccountError =
  | 'forbidden'
  | 'not_found'
  | 'has_work'
  | 'not_allowed'
  | 'reason_required'
  | 'reason_too_long'
  | 'generic'

export type AccountActionState = {
  status: 'idle' | 'done' | 'error'
  error?: AccountError
  /** Changes on every success, so the page can react to a second success too. */
  doneAt?: number
}

export const IDLE: AccountActionState = { status: 'idle' }
