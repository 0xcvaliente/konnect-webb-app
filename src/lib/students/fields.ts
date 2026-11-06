/**
 * The student profile's answer options and limits, shared by the onboarding, the profile page,
 * the server checks and the collection. Nothing here imports server code, so client components
 * can use it too. Labels live in the message files (StudentFields).
 */

/**
 * What a student may agree to share with the company after Konnected selects them. Every item is
 * off until the student ticks it (owner decision: a selected student shares nothing until they
 * tick each item). The pages list them in this order. `shareSchool` covers school, programme and
 * study year.
 */
export const SHARE_KEYS = [
  'shareName',
  'shareSchool',
  'sharePitch',
  'shareSkills',
  'shareExperience',
  'shareCv',
  'shareContactEmail',
  'sharePhone',
] as const
export type ShareKey = (typeof SHARE_KEYS)[number]

/**
 * Konnected reviews every profile by hand, within 2 working days, before matching. The team may
 * ask the student for changes (with a note); the student's next save sends it back to `waiting`.
 */
export const REVIEW_STATUSES = ['waiting', 'changes_requested', 'reviewed'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** Profile review promise: within 2 working days of the profile being sent. */
export const PROFILE_REVIEW_DAYS = 2

/** The longest note the team can write to a student about their profile. */
export const REVIEW_NOTE_MAX = 2000

/**
 * What Konnected looks at in a review. A copy of these is kept when the team marks the profile
 * reviewed, so the team can see what the student changed since (owner decision: editing a
 * reviewed profile keeps it reviewed, and the team sees what changed).
 */
export const REVIEWED_FIELDS = [
  'name',
  'school',
  'programme',
  'year',
  'pitch',
  'skills',
  'interests',
  'preferredProjectTypes',
  'experience',
  'highlights',
  'contactEmail',
  'phone',
  'cv',
  'privacy',
] as const
export type ReviewedField = (typeof REVIEWED_FIELDS)[number]
export type ReviewSnapshot = Partial<Record<ReviewedField, unknown>>

/** A stored value in the form the snapshot keeps: ids for relations, `null` for empty. */
const snapshotValue = (key: ReviewedField, value: unknown): unknown => {
  if (value === undefined || value === '' || value === null) return null
  if (key === 'cv') {
    return typeof value === 'object' ? ((value as { id?: unknown }).id ?? null) : value
  }
  if (Array.isArray(value)) return value.length ? [...value] : null
  if (key === 'privacy' && typeof value === 'object') {
    return Object.fromEntries(
      SHARE_KEYS.map((k) => [k, (value as Record<string, unknown>)[k] === true]),
    )
  }
  return value
}

/** The reviewed fields of a profile, as the snapshot stores them. */
export function reviewSnapshot(profile: Record<string, unknown>): ReviewSnapshot {
  return Object.fromEntries(REVIEWED_FIELDS.map((k) => [k, snapshotValue(k, profile[k])]))
}

/** JSON with object keys in a fixed order (the database may store them in another order). */
export const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  )

/** The reviewed fields whose value differs between a snapshot and a profile. */
export function changedFields(
  snapshot: ReviewSnapshot | null | undefined,
  profile: Record<string, unknown>,
): ReviewedField[] {
  if (!snapshot) return []
  const now = reviewSnapshot(profile)
  return REVIEWED_FIELDS.filter((k) => canonical(snapshot[k]) !== canonical(now[k]))
}

/** The kinds of work a student can pick as interests. Stored as these keys. */
export const INTEREST_KEYS = [
  'marketing',
  'design',
  'research',
  'data',
  'software',
  'business',
  'writing',
  'testing',
] as const
export type InterestKey = (typeof INTEREST_KEYS)[number]

/** The kinds of project a student would like. Stored as these keys. */
export const PROJECT_TYPE_KEYS = ['paid', 'unpaid', 'remote', 'onSite'] as const
export type ProjectTypeKey = (typeof PROJECT_TYPE_KEYS)[number]

/** Schools offered as quick answers in the onboarding. Any other school can be typed. */
export const SCHOOL_KEYS = ['ntnu', 'uio', 'uib', 'bi', 'nhh', 'oslomet'] as const

/** Study years offered. 6 means "6th year or later". The collection allows 1 to 10. */
export const YEARS = [1, 2, 3, 4, 5, 6] as const

export const LIMITS = {
  name: 120,
  school: 120,
  programme: 120,
  pitch: 600,
  skill: 50,
  skills: 20,
  experience: 2000,
  highlights: 2000,
  contactEmail: 254,
  phone: 30,
} as const

/** Skills are typed as one line, separated by commas. Trimmed, without empties or repeats. */
export const splitSkills = (value: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(/[,\n]/)) {
    const skill = raw.trim().replace(/\s+/g, ' ')
    const key = skill.toLowerCase()
    if (skill && !seen.has(key)) {
      seen.add(key)
      out.push(skill)
    }
  }
  return out
}

/**
 * The check Payload's own `email` field runs (payload 3.93.0, fields/validations.js), copied here
 * because that file needs a request and this one must stay safe for the browser. ASCII only, a
 * top-level domain of 2 or more letters, no "..", no dot at either end of the name. If the form
 * accepted an address Payload refuses, the save would fail instead of marking the field. A test
 * checks this still agrees with Payload's validator.
 */
export const EMAIL_PATTERN =
  /^(?!.*\.\.)[\w!#$%&'*+/=?^`{|}~-](?:[\w!#$%&'*+/=?^`{|}~.-]*[\w!#$%&'*+/=?^`{|}~-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i

/** The field names a profile form can report a problem on. */
export const PROFILE_FIELDS = [
  'name',
  'school',
  'programme',
  'year',
  'pitch',
  'skills',
  'interests',
  'preferredProjectTypes',
  'experience',
  'highlights',
  'contactEmail',
  'phone',
  'cv',
] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]

export type FieldProblem = 'required' | 'too_long' | 'invalid' | 'too_many'

export type ProfileFieldErrors = Partial<Record<ProfileField, FieldProblem>>

/** The answer a profile Server Action gives the page. */
export type ProfileFormState = {
  status: 'idle' | 'done' | 'error'
  /** A problem with the whole request, not one field. */
  error?: 'forbidden' | 'exists' | 'no_profile' | 'generic'
  fields?: ProfileFieldErrors
  /** Changes on every save, so the page can show "Saved" again after a second save. */
  savedAt?: number
}

export const IDLE: ProfileFormState = { status: 'idle' }
