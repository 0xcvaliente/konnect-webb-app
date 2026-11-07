import type { ApplicationStatus } from '@/lib/transitions'
import { addWorkingDays } from '@/lib/workingDays'

/**
 * Applying to a project and following the application (Kanban card "Apply to a project and track
 * applications"). Plain values and types only, so client components can import this file.
 *
 * Owner rules (6 Nov 2026): one application per student and project, ever (no re-applying after
 * withdrawing); at most 2 running projects per student; a decision within 3 working days after
 * applications close.
 */

export const APPLICATION_STATUSES = [
  'applied',
  'shortlisted',
  'selected',
  'not_selected',
  'withdrawn',
] as const satisfies readonly ApplicationStatus[]

/** The student's short note on why they fit, in characters. */
export const NOTE_MAX = 1000

/** A student works on at most this many projects at once. */
export const MAX_RUNNING_PROJECTS = 2

/**
 * A project counts as running for its student while it is matched or in progress (product rules,
 * permissions and lifecycle). Delivered projects do not count (open question to the owner).
 */
export const RUNNING_PROJECT_STATUSES = ['matched', 'in_progress'] as const

/** Konnected decides within this many working days after applications close. */
export const DECISION_DAYS = 3

/** A student may withdraw while Konnected is still deciding. */
export const WITHDRAWABLE: readonly ApplicationStatus[] = ['applied', 'shortlisted']
export const canWithdraw = (status: ApplicationStatus): boolean => WITHDRAWABLE.includes(status)

/** The status pill tone ("Final pass" mockup). */
export const APPLICATION_STATUS_TONE: Record<
  ApplicationStatus,
  'ok' | 'warn' | 'bad' | 'info' | 'mute'
> = {
  applied: 'info',
  shortlisted: 'warn',
  selected: 'ok',
  not_selected: 'mute',
  withdrawn: 'mute',
}

/**
 * The last day of the decision promise: 3 working days (Norwegian, Europe/Oslo) after the day
 * applications close. Null when the project has no closing day.
 */
export const decisionDay = (closingDay: string | null): string | null =>
  closingDay ? addWorkingDays(closingDay, DECISION_DAYS) : null

/** Why the server refused an application. Each has its own message in both languages. */
export const APPLY_ERRORS = [
  'forbidden',
  'no_profile',
  'not_open',
  'closed',
  'already_applied',
  'withdrawn_before',
  'too_many',
  'changes_requested',
  'note_required',
  'note_too_long',
  'generic',
] as const
export type ApplyError = (typeof APPLY_ERRORS)[number]

export const WITHDRAW_ERRORS = ['forbidden', 'not_found', 'not_withdrawable', 'generic'] as const
export type WithdrawError = (typeof WITHDRAW_ERRORS)[number]

export type ApplyState =
  | { status: 'idle' }
  | { status: 'done'; applicationId: number; doneAt: number }
  | { status: 'error'; error: ApplyError; doneAt: number }

export type WithdrawState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: WithdrawError; doneAt: number }

export const APPLY_IDLE: ApplyState = { status: 'idle' }
export const WITHDRAW_IDLE: WithdrawState = { status: 'idle' }

/** "Show first" on My applications. */
export const APPLICATION_SORTS = ['need', 'recent', 'company'] as const
export type ApplicationSort = (typeof APPLICATION_SORTS)[number]
export const readSort = (value: unknown): ApplicationSort =>
  typeof value === 'string' && (APPLICATION_SORTS as readonly string[]).includes(value)
    ? (value as ApplicationSort)
    : 'need'

/** Order for "needs you first": open applications first, finished ones last. */
export const STATUS_ORDER: Record<ApplicationStatus, number> = {
  selected: 0,
  shortlisted: 1,
  applied: 2,
  not_selected: 3,
  withdrawn: 4,
}
