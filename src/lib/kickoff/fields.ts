/**
 * Kick-off (Kanban card "Kick-off form and kick-off cards (student and company)"). Plain values,
 * types and pure rules only, so client components, the Matches hook and the team pages share them.
 *
 * After Konnected selects a student, the team agrees the plan with the student and the company and
 * records it on the match: the agreed scope, the start and due dates, the check-in dates, the
 * Konnected contact and how to deliver. The student and the company each see it on their project
 * page. The student agreement is made only after the kick-off is recorded (it uses the dates), and
 * the work starts only after that agreement is signed.
 *
 * The kick-off can change while the project is `matched` and no student agreement is in use. Once
 * an agreement is made from it, the team withdraws that agreement first; once the work runs, the
 * due date moves only through "Move the due date" (problem paths).
 */

export const KICKOFF_LIMITS = {
  scope: 2000,
  delivery: 1000,
  /** Check-in dates on one kick-off. */
  checkIns: 6,
} as const

/** Why recording the kick-off or starting the work was refused. Each has a message in EN and NO. */
export const KICKOFF_ERRORS = [
  'forbidden',
  'not_found',
  /** The project is not matched (any more): the kick-off is fixed once the work runs. */
  'not_open',
  /** A student agreement is made from the kick-off: withdraw it first to change the plan. */
  'agreement_in_use',
  'scope_required',
  'scope_too_long',
  'delivery_required',
  'delivery_too_long',
  'start_invalid',
  'due_invalid',
  /** The due date is before the start date. */
  'due_before_start',
  /** A check-in is not a day between the start and the due date. */
  'check_in_invalid',
  'too_many_check_ins',
  'contact_required',
  /** Starting the work: the kick-off is not recorded yet. */
  'no_kickoff',
  /** Starting the work: the student agreement is not signed by the student and Konnected. */
  'not_signed',
  /** The note to the company is longer than the limit. */
  'note_too_long',
  /** Someone else acted first: load the page again. */
  'changed',
  'generic',
] as const
export type KickoffError = (typeof KICKOFF_ERRORS)[number]

export type KickoffState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: KickoffError; doneAt: number }

export const KICKOFF_IDLE: KickoffState = { status: 'idle' }

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function kickoffErrorCode(error: unknown): KickoffError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (KICKOFF_ERRORS as readonly string[]).includes(code))
      return code as KickoffError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** The kick-off as the pages show it. Days are `YYYY-MM-DD` in Oslo. */
export type KickoffView = {
  scope: string
  delivery: string
  startDay: string | null
  dueDay: string | null
  checkIns: string[]
  /** The Konnected contact's name (copied when the kick-off was saved). */
  contactName: string
  /** When the kick-off was first recorded (ISO). */
  recordedAt: string
}

/** Where the student agreement of a match stands, for the kick-off cards. */
export type StudentAgreementStage =
  'none' | 'generating' | 'awaiting_party' | 'awaiting_konnected' | 'signed' | 'failed'
