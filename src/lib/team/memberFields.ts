/*
 * Limits and form states for the team workspace (owners, the shared pool, away and cover). Plain
 * values only, so client components can import them.
 */

/** Away for at most this many days in one go. */
export const AWAY_MAX_DAYS = 90

/** A reassignment note: why the work moves. Kept in the activity log. */
export const REASSIGN_NOTE_MIN = 3
export const REASSIGN_NOTE_MAX = 500

/** A shared-pool item turns amber after it has waited this many working days untaken. */
export const POOL_AMBER_DAYS = 2

/** The morning email goes out from this time (Oslo) on working days. */
export const MORNING_EMAIL_AT = { hour: 7, minute: 30 } as const

/** What can be taken from the shared pool. */
export const POOL_KINDS = ['companies', 'projects', 'student-profiles'] as const
export type PoolCollection = (typeof POOL_KINDS)[number]
export const isPoolCollection = (value: unknown): value is PoolCollection =>
  typeof value === 'string' && (POOL_KINDS as readonly string[]).includes(value)

export type TeamFormError = 'note' | 'owner' | 'dates' | 'cover' | 'taken' | 'notFound' | 'failed'

export type TeamFormState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: TeamFormError; doneAt: number }

export const TEAM_IDLE: TeamFormState = { status: 'idle' }
export const teamDone = (): TeamFormState => ({ status: 'done', doneAt: Date.now() })
export const teamFail = (error: TeamFormError): TeamFormState => ({
  status: 'error',
  error,
  doneAt: Date.now(),
})
