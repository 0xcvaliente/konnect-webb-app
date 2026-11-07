/**
 * The project form's answer options, limits and checks, shared by the company's form, the server
 * actions, the collection and its hooks. Nothing here imports server code, so client components
 * can use it too. Labels live in the message files (ProjectFields).
 */

/** Where the work is done. `location` holds the place when it is not remote. */
export const WORK_MODES = ['remote', 'on_site', 'hybrid'] as const
export type WorkMode = (typeof WORK_MODES)[number]

/**
 * Paid or unpaid: the company chooses when it submits; Konnected makes the final decision at
 * review (owner decision 2026-11-05). An unpaid project says what the student gets instead.
 */
export const PAY_CHOICES = ['paid', 'unpaid'] as const
export type PayChoice = (typeof PAY_CHOICES)[number]

/** The timeframes a company can pick, in weeks (mockup "Submit a project", Timeframe). */
export const DURATION_WEEKS = [1, 2, 3, 4, 6] as const

export const LIMITS = {
  title: 120,
  description: 4000,
  tasks: 3000,
  deliverable: 2000,
  skill: 40,
  skills: 10,
  location: 120,
  unpaidBenefit: 1000,
  hoursMin: 1,
  hoursMax: 400,
} as const

/** At most this many brief attachments on one project (same as the brief-files collection). */
export const MAX_ATTACHMENTS = 10

/** Brief attachments: these types, 20 MB each (same as the brief-files collection). */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
export const ATTACHMENT_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg'] as const

/** The statuses in which the company can still change its project. */
export const COMPANY_EDITABLE = ['draft', 'changes_requested'] as const

/** Every field the company fills in. The order is the form's order. */
export const PROJECT_FIELDS = [
  'title',
  'description',
  'tasks',
  'desiredSkills',
  'workloadHours',
  'durationWeeks',
  'startDate',
  'workMode',
  'location',
  'deadline',
  'deliverable',
  'paidOrUnpaid',
  'unpaidBenefit',
  'attachments',
] as const
export type ProjectField = (typeof PROJECT_FIELDS)[number]

export const PROJECT_FIELD_PROBLEMS = [
  'required',
  'too_long',
  'too_many',
  'invalid',
  'past',
  'before_deadline',
] as const
export type ProjectFieldProblem = (typeof PROJECT_FIELD_PROBLEMS)[number]
export type ProjectFieldErrors = Partial<Record<ProjectField, ProjectFieldProblem>>

/**
 * What the company's form sends: text as typed, dates as `YYYY-MM-DD`, numbers as text, skills
 * as one comma-separated line, attachments as brief-file ids. The server reads it again from
 * scratch (readProjectInput) and never trusts it.
 */
export type ProjectInput = {
  title: string
  description: string
  tasks: string
  desiredSkills: string
  workloadHours: string
  durationWeeks: string
  startDate: string
  workMode: string
  location: string
  deadline: string
  deliverable: string
  paidOrUnpaid: string
  unpaidBenefit: string
  attachments: number[]
}

export const EMPTY_INPUT: ProjectInput = {
  title: '',
  description: '',
  tasks: '',
  desiredSkills: '',
  workloadHours: '',
  durationWeeks: '',
  startDate: '',
  workMode: '',
  location: '',
  deadline: '',
  deliverable: '',
  paidOrUnpaid: '',
  unpaidBenefit: '',
  attachments: [],
}

/** The answer a project Server Action gives the form. */
export type ProjectFormState = {
  status: 'saved' | 'sent' | 'error'
  /** The project's id once it exists (the first save creates it). */
  id?: number
  fields?: ProjectFieldErrors
  error?: 'forbidden' | 'not_editable' | 'not_approved' | 'not_found' | 'generic'
}

/** "Copywriting, Email marketing" as a clean list: trimmed, no empties, no repeats. */
export function parseSkills(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(',')) {
    const skill = raw.trim().replace(/\s+/g, ' ')
    const key = skill.toLowerCase()
    if (!skill || seen.has(key)) continue
    seen.add(key)
    out.push(skill)
  }
  return out
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A `YYYY-MM-DD` date that exists, or null. */
export function parseDay(value: string | null | undefined): string | null {
  const match = typeof value === 'string' ? DATE.exec(value.trim()) : null
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
    ? `${y}-${m}-${d}`
    : null
}

/**
 * A day as stored: noon UTC, so it is the same calendar day in Norway and anywhere in Europe.
 * Payload stores dates as timestamps.
 */
export const dayToStored = (day: string): string => `${day}T12:00:00.000Z`

/** A stored date (or a `Date`) back to `YYYY-MM-DD`, or null. */
export const storedToDay = (value: unknown): string | null => {
  const text = value instanceof Date ? value.toISOString() : value
  return typeof text === 'string' && text.length >= 10 ? parseDay(text.slice(0, 10)) : null
}

/** Today in Norway as `YYYY-MM-DD`. */
export function todayInOslo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** The values the review needs, as stored (dates as timestamps or days). */
export type ReviewInput = {
  title?: string | null
  description?: string | null
  deliverable?: string | null
  desiredSkills?: string[] | null
  workloadHours?: number | null
  durationWeeks?: number | null
  startDate?: unknown
  workMode?: string | null
  location?: string | null
  paidOrUnpaid?: string | null
  unpaidBenefit?: string | null
  deadline?: unknown
}

const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim())

/**
 * What is still missing or wrong before a company can send a project for review. Empty when it is
 * ready. The collection hook runs this on every company submission (REST, GraphQL, Local API);
 * the form runs it first to mark the fields. `today` is a `YYYY-MM-DD` day in Norway.
 *
 * Applications must close today or later, and the work starts after they close (Konnected picks a
 * student in between).
 */
export function problemsForReview(p: ReviewInput, today: string = todayInOslo()) {
  const errors: ProjectFieldErrors = {}
  for (const key of ['title', 'description', 'deliverable'] as const) {
    if (blank(p[key])) errors[key] = 'required'
  }
  if (!p.desiredSkills?.length) errors.desiredSkills = 'required'
  if (!p.workloadHours) errors.workloadHours = 'required'
  if (!p.durationWeeks) errors.durationWeeks = 'required'
  if (!p.workMode) errors.workMode = 'required'
  else if (p.workMode !== 'remote' && blank(p.location)) errors.location = 'required'
  if (!p.paidOrUnpaid) errors.paidOrUnpaid = 'required'
  else if (p.paidOrUnpaid === 'unpaid' && blank(p.unpaidBenefit)) errors.unpaidBenefit = 'required'

  const deadline =
    typeof p.deadline === 'string' && DATE.test(p.deadline)
      ? parseDay(p.deadline)
      : storedToDay(p.deadline)
  const start =
    typeof p.startDate === 'string' && DATE.test(p.startDate)
      ? parseDay(p.startDate)
      : storedToDay(p.startDate)
  if (!deadline) errors.deadline = 'required'
  else if (deadline < today) errors.deadline = 'past'
  if (!start) errors.startDate = 'required'
  else if (start < today) errors.startDate = 'past'
  else if (deadline && start <= deadline) errors.startDate = 'before_deadline'
  return errors
}

/** What a company may write on a project, ready for Payload. */
export type ProjectData = {
  title: string
  description: string | null
  tasks: string | null
  deliverable: string | null
  desiredSkills: string[]
  workloadHours: number | null
  durationWeeks: number | null
  startDate: string | null
  workMode: WorkMode | null
  location: string | null
  paidOrUnpaid: PayChoice | null
  unpaidBenefit: string | null
  deadline: string | null
  attachments: number[]
}

const str = (value: unknown, max = 20_000): string =>
  typeof value === 'string' ? value.slice(0, max).trim() : ''

/**
 * Read what the form sent. A draft may be incomplete, so only the title is required here; what is
 * given must still be valid (lengths, numbers, options, real dates). Sending for review checks the
 * rest (problemsForReview). Works on anything: the input comes from the browser.
 */
export function readProjectInput(
  input: unknown,
  errors: ProjectFieldErrors,
): { data: ProjectData; days: { startDate: string | null; deadline: string | null } } {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  const limited = (
    name: 'title' | 'description' | 'tasks' | 'deliverable' | 'location' | 'unpaidBenefit',
  ) => {
    const value = str(raw[name])
    if (value.length > LIMITS[name]) errors[name] = 'too_long'
    return value
  }

  const title = limited('title')
  if (!title) errors.title = 'required'

  const skills = parseSkills(str(raw.desiredSkills))
  if (skills.length > LIMITS.skills) errors.desiredSkills = 'too_many'
  else if (skills.some((s) => s.length > LIMITS.skill)) errors.desiredSkills = 'too_long'

  const whole = (name: 'workloadHours' | 'durationWeeks'): number | null => {
    const text = str(raw[name])
    if (!text) return null
    const n = Number(text)
    if (!Number.isInteger(n)) {
      errors[name] = 'invalid'
      return null
    }
    return n
  }
  let workloadHours = whole('workloadHours')
  if (
    workloadHours !== null &&
    (workloadHours < LIMITS.hoursMin || workloadHours > LIMITS.hoursMax)
  ) {
    errors.workloadHours = 'invalid'
    workloadHours = null
  }
  let durationWeeks = whole('durationWeeks')
  if (durationWeeks !== null && !(DURATION_WEEKS as readonly number[]).includes(durationWeeks)) {
    errors.durationWeeks = 'invalid'
    durationWeeks = null
  }

  const day = (name: 'startDate' | 'deadline'): string | null => {
    const text = str(raw[name])
    if (!text) return null
    const parsed = parseDay(text)
    if (!parsed) errors[name] = 'invalid'
    return parsed
  }
  const startDate = day('startDate')
  const deadline = day('deadline')

  const option = <T extends string>(name: ProjectField, options: readonly T[]): T | null => {
    const text = str(raw[name])
    if (!text) return null
    if ((options as readonly string[]).includes(text)) return text as T
    errors[name] = 'invalid'
    return null
  }
  const workMode = option('workMode', WORK_MODES)
  const paidOrUnpaid = option('paidOrUnpaid', PAY_CHOICES)

  const attachments: number[] = []
  const list = Array.isArray(raw.attachments) ? raw.attachments : []
  for (const value of list) {
    const id = typeof value === 'number' ? value : Number(value)
    if (!Number.isInteger(id) || id <= 0) errors.attachments = 'invalid'
    else if (!attachments.includes(id)) attachments.push(id)
  }
  if (attachments.length > MAX_ATTACHMENTS) errors.attachments = 'too_many'

  const orNull = (value: string) => value || null
  const location = limited('location')
  const unpaidBenefit = limited('unpaidBenefit')
  return {
    data: {
      title,
      description: orNull(limited('description')),
      tasks: orNull(limited('tasks')),
      deliverable: orNull(limited('deliverable')),
      desiredSkills: skills,
      workloadHours,
      durationWeeks,
      startDate: startDate ? dayToStored(startDate) : null,
      workMode,
      // The place only matters when the work is not remote.
      location: workMode && workMode !== 'remote' ? orNull(location) : null,
      paidOrUnpaid,
      // What the student gets only matters for an unpaid project.
      unpaidBenefit: paidOrUnpaid === 'unpaid' ? orNull(unpaidBenefit) : null,
      deadline: deadline ? dayToStored(deadline) : null,
      attachments,
    },
    days: { startDate, deadline },
  }
}
