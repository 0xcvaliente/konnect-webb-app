import type { Match } from '@/payload-types'

/**
 * Manual matching (Kanban card "Admin applications queue and manual matching"). Plain values and
 * types only, so client components can import this file.
 *
 * Konnected picks one student per project by hand. Selecting one application creates the match,
 * marks every other open application `not_selected` and moves the project to `matched`, in one
 * transaction (the Applications hook). The company then sees only `sharedInfo` on the match: a
 * copy of what the student ticked to share.
 */

/**
 * What a company may see about its selected student, in the order the pages list them. `school`
 * covers school, programme and study year (one tick, `shareSchool`).
 */
export const SHARED_ITEMS = [
  'name',
  'school',
  'skills',
  'pitch',
  'experience',
  'cv',
  'contactEmail',
  'phone',
] as const
export type SharedItem = (typeof SHARED_ITEMS)[number]

type SharedInfo = NonNullable<Match['sharedInfo']>

const present = (value: unknown): boolean =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== ''

/** The items the match's copy holds: what the student shares, and has filled in. */
export function sharedItemsOf(shared: SharedInfo | null | undefined): SharedItem[] {
  if (!shared) return []
  return SHARED_ITEMS.filter((item) =>
    item === 'school'
      ? present(shared.school) || present(shared.programme) || present(shared.year)
      : present(shared[item]),
  )
}

/** Why the team could not shortlist or select. Each has its own message in both languages. */
export const MATCH_ERRORS = [
  'forbidden',
  'not_found',
  /** The application is no longer open (withdrawn, or someone decided first). */
  'not_open',
  /** The project is no longer published (matched or closed by someone else first). */
  'project_not_open',
  /** The project already has a match. */
  'already_matched',
  /** Konnected reviews every profile before matching. */
  'profile_not_reviewed',
  /** The student already has 2 projects running or picked. */
  'too_many',
  'generic',
] as const
export type MatchError = (typeof MATCH_ERRORS)[number]

export type MatchState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: MatchError; doneAt: number }

export const MATCH_IDLE: MatchState = { status: 'idle' }

/** Skills the project asks for that the applicant lists, compared without case or spaces. */
export function skillHits(asked: readonly string[], has: readonly string[]): boolean[] {
  const own = new Set(has.map((s) => s.trim().toLocaleLowerCase('nb')))
  return asked.map((s) => own.has(s.trim().toLocaleLowerCase('nb')))
}
