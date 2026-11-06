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

/** Konnected reviews every profile by hand, within 2 working days, before matching. */
export const REVIEW_STATUSES = ['waiting', 'reviewed'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

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
