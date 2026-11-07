/**
 * Shared shapes for the team's approval queue. No server imports, so client components can use
 * them too.
 */

export const QUEUE_TABS = ['companies', 'projects', 'students'] as const
export type QueueTab = (typeof QUEUE_TABS)[number]

export const isQueueTab = (value: unknown): value is QueueTab =>
  (QUEUE_TABS as readonly unknown[]).includes(value)

/** The longest note the team can send with a decision. Matches the notes on the records. */
export const NOTE_MAX = 2000

export type ReviewError =
  | 'forbidden'
  | 'not_found'
  /** The item is no longer where this decision applies (someone else decided first). */
  | 'not_allowed'
  | 'note_required'
  | 'note_too_long'
  | 'pay_choice'
  | 'price_required'
  | 'price_invalid'
  /** The project's company is not approved (any more): approve the company first. */
  | 'company_not_approved'
  /** Another approved company has this organisation number. */
  | 'duplicate_org'
  /** Publishing needs the company agreement signed by the company and Konnected. */
  | 'agreement_unsigned'
  /** The signed company agreement no longer matches the project (price, scope or company). */
  | 'agreement_changed'
  | 'generic'

export type ReviewState = {
  status: 'idle' | 'done' | 'error'
  error?: ReviewError
  /** Changes on every success, so the page can react to a second success too. */
  doneAt?: number
}

export const IDLE: ReviewState = { status: 'idle' }
