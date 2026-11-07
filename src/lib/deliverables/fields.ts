import { addDays, osloDay } from '@/lib/workingDays'

/**
 * Deliverables (Kanban card "Deliverable submission and handoff"). Plain values, types and pure
 * rules only, so client components and the collection hook share them.
 *
 * The flow, one deliverable per hand-in:
 * - the student sends files and links with a note: `submitted`;
 * - Konnected checks it, then releases it to the company (`released`) or asks the student for
 *   more (`returned`; the student then sends a new hand-in);
 * - the company sees released work only. It accepts it (`accepted`) or asks for one round of fixes
 *   (`fix_requested`) within 7 days of the release (owner rule). After those 7 days the work
 *   counts as accepted; a scheduled job records that (`accepted`, by `auto`).
 * - a fix request opens the work again for the student, with the company's note. The fixed
 *   hand-in goes through Konnected again; the company can then only accept it.
 */

export const DELIVERABLE_STATUSES = [
  'submitted',
  'returned',
  'released',
  'fix_requested',
  'accepted',
] as const
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number]

/** Statuses a company may see: only what Konnected released, and what happened after. */
export const RELEASED_STATUSES = ['released', 'fix_requested', 'accepted'] as const

export const isReleased = (status: DeliverableStatus): boolean =>
  (RELEASED_STATUSES as readonly string[]).includes(status)

/** The company may ask for fixes until the end of this many days after the release (Oslo). */
export const FIX_WINDOW_DAYS = 7

/** Project statuses in which the student works and may hand in. */
export const WORK_PROJECT_STATUSES = ['in_progress', 'delivered'] as const

export const MAX_LINKS = 10
export const NOTE_MAX = 2000
export const LINK_LABEL_MAX = 100
export const LINK_URL_MAX = 500

/** Who accepted: the company, the team on its behalf, or nobody within the 7 days. */
export const ACCEPTED_BY = ['company', 'team', 'auto'] as const
export type AcceptedBy = (typeof ACCEPTED_BY)[number]

export const DELIVERABLE_STATUS_TONE: Record<DeliverableStatus, 'ok' | 'warn' | 'bad' | 'info'> = {
  submitted: 'info',
  returned: 'warn',
  released: 'ok',
  fix_requested: 'warn',
  accepted: 'ok',
}

/** A link is an http or https address. */
export function isWebLink(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > LINK_URL_MAX) return false
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname)
  } catch {
    return false
  }
}

/** The last day (Oslo, `YYYY-MM-DD`) the company may ask for fixes on work released at `at`. */
export const fixUntilDay = (releasedAt: string | Date): string =>
  addDays(osloDay(new Date(releasedAt)), FIX_WINDOW_DAYS)

/** The 7 days after the release are over, so the work counts as accepted. */
export const fixWindowOver = (releasedAt: string | Date, now: Date = new Date()): boolean =>
  osloDay(now) > fixUntilDay(releasedAt)

/** The fields of a deliverable the rules below need. */
export type DeliveryItem = {
  id: number
  status: DeliverableStatus
  createdAt: string
  releasedAt?: string | null
  fixRequestedAt?: string | null
}

export type DeliveryState = {
  /** The hand-in waiting for Konnected, if any. */
  waiting: DeliveryItem | null
  /** The newest hand-in Konnected released (whatever happened after). */
  current: DeliveryItem | null
  /** The company used its one round of fixes. */
  fixUsed: boolean
  /** The fix round is open: the company asked, and no fixed hand-in was released yet. */
  fixOpen: boolean
  /** The work is accepted, by the company, the team, or because 7 days passed. */
  accepted: boolean
  /** The student may send a hand-in now. */
  canSubmit: boolean
  /** Why not, when `canSubmit` is false. */
  blocked: 'not_started' | 'waiting' | 'done' | null
  /** The company may accept the current release. */
  canAccept: boolean
  /** The company may ask for its one round of fixes on the current release. */
  canAskFix: boolean
  /** The last day the company may ask for fixes (Oslo), while it still may. */
  fixUntil: string | null
}

const newest = <T extends { createdAt: string }>(items: T[]): T | null =>
  items.reduce<T | null>(
    (best, item) => (!best || item.createdAt > best.createdAt ? item : best),
    null,
  )

/**
 * Where the work on one match stands, from its hand-ins and the project's status. The collection
 * hook uses it to refuse what is not allowed (for every API); the pages use it to show what can be
 * done. `now` decides whether the 7 days after a release are over.
 */
export function deliveryState(
  items: DeliveryItem[],
  projectStatus: string | null | undefined,
  now: Date = new Date(),
): DeliveryState {
  const waiting = newest(items.filter((d) => d.status === 'submitted'))
  const released = items.filter((d) => isReleased(d.status) && d.releasedAt)
  const current = released.reduce<DeliveryItem | null>(
    (best, d) => (!best || d.releasedAt! > best.releasedAt! ? d : best),
    null,
  )
  const fixUsed = items.some((d) => d.status === 'fix_requested' || Boolean(d.fixRequestedAt))
  const fixOpen = current?.status === 'fix_requested'
  const windowOver = current?.releasedAt ? fixWindowOver(current.releasedAt, now) : false
  const accepted = current?.status === 'accepted' || (current?.status === 'released' && windowOver)
  const working = (WORK_PROJECT_STATUSES as readonly string[]).includes(projectStatus ?? '')

  let blocked: DeliveryState['blocked'] = null
  if (!working) blocked = 'not_started'
  else if (waiting) blocked = 'waiting'
  else if (current && !fixOpen) blocked = 'done'

  const canAccept = current?.status === 'released'
  const canAskFix = current?.status === 'released' && !fixUsed && !windowOver
  return {
    waiting,
    current,
    fixUsed,
    fixOpen,
    accepted,
    canSubmit: blocked === null,
    blocked,
    canAccept,
    canAskFix,
    fixUntil: canAskFix && current?.releasedAt ? fixUntilDay(current.releasedAt) : null,
  }
}

/** Why a deliverable action was refused. Each has its own message in both languages. */
export const DELIVERABLE_ERRORS = [
  'forbidden',
  'not_found',
  /** Someone else acted first, or the state changed: load the page again. */
  'not_open',
  /** The project is not in progress (the work has not started, or it is closed). */
  'not_started',
  /** A hand-in already waits for Konnected. */
  'waiting',
  /** The work was released and no fix was asked: nothing more to hand in. */
  'done',
  /** No file and no link. */
  'empty',
  'too_many_files',
  'bad_link',
  'too_many_links',
  'note_required',
  'note_too_long',
  /** The company already used its one round of fixes. */
  'fix_used',
  /** The 7 days after the release are over. */
  'fix_window',
  'generic',
] as const
export type DeliverableError = (typeof DELIVERABLE_ERRORS)[number]

export type DeliverableState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: DeliverableError; doneAt: number }

export const DELIVERABLE_IDLE: DeliverableState = { status: 'idle' }

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function deliverableErrorCode(error: unknown): DeliverableError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (DELIVERABLE_ERRORS as readonly string[]).includes(code))
      return code as DeliverableError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A file size in words for lists ("860 KB", "2.4 MB"). */
export const fileSizeText = (bytes: number | null | undefined): string | null => {
  if (!bytes) return null
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** File types a hand-in accepts (DELIVERABLE_FILE_RULE), for the file picker and a quick check. */
export const HAND_IN_EXTENSIONS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'zip',
] as const
export const HAND_IN_MAX_BYTES = 50 * 1024 * 1024
