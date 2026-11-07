import { isValidPrice, PAYMENT_TERMS_DAYS, priceBreakdown, type PriceBreakdown } from '@/lib/money'
import { addDays } from '@/lib/workingDays'

/**
 * The manual payment log (Kanban card "Manual payment log in admin"). Plain values, types and pure
 * rules only, so client components and the collection hook share them.
 *
 * One row per paid match. Konnected's fixed price excludes VAT; 25 % VAT is added on the invoice
 * and payment terms are 14 days (konnected-product-rules, money). The team records by hand when
 * the invoice was sent, when the company paid, and when the student was paid in the monthly pay
 * run (only after the company paid). How students are paid (employee or freelancer) is open, so
 * nothing here models tax or payroll.
 */

/** Where a row stands, for the team. */
export const PAYMENT_STATUSES = [
  /** The work is not released yet: nothing to invoice. */
  'not_released',
  /** The work is released: send the invoice. */
  'to_invoice',
  /** Invoice sent, the 14 days are running. */
  'invoice_sent',
  /** Invoice sent, more than 14 days ago, not paid. */
  'overdue',
  /** The company paid: pay the student in the next pay run. */
  'student_to_pay',
  /** The company paid and the student is paid. */
  'settled',
] as const
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

/** Statuses that need the team to do something. */
export const ACTION_STATUSES: readonly PaymentStatus[] = ['to_invoice', 'overdue', 'student_to_pay']

export const PAYMENT_STATUS_TONE: Record<PaymentStatus, 'ok' | 'warn' | 'bad' | 'info' | 'mute'> = {
  not_released: 'mute',
  to_invoice: 'warn',
  invoice_sent: 'info',
  overdue: 'bad',
  student_to_pay: 'warn',
  settled: 'ok',
}

/** The team's filter on the log: everything, what needs action, or one status. */
export const PAYMENT_FILTERS = ['all', 'action', ...PAYMENT_STATUSES] as const
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number]
export const readPaymentFilter = (value: unknown): PaymentFilter =>
  (PAYMENT_FILTERS as readonly unknown[]).includes(value) ? (value as PaymentFilter) : 'action'

export const INVOICE_NUMBER_MAX = 40
export const PAYMENT_NOTES_MAX = 2000

/** The dates of a row, as `YYYY-MM-DD` in Oslo, or null. */
export type PaymentDays = {
  invoiceSent: string | null
  invoicePaid: string | null
  studentPaid: string | null
}

/** The day the invoice is due: 14 days after it was sent. */
export const dueDay = (invoiceSent: string | null): string | null =>
  invoiceSent ? addDays(invoiceSent, PAYMENT_TERMS_DAYS) : null

/** Where a row stands. `released`: the project's work was released to the company. */
export function paymentStatus(days: PaymentDays, released: boolean, today: string): PaymentStatus {
  if (days.studentPaid) return 'settled'
  if (days.invoicePaid) return 'student_to_pay'
  if (days.invoiceSent) return today > dueDay(days.invoiceSent)! ? 'overdue' : 'invoice_sent'
  return released ? 'to_invoice' : 'not_released'
}

/** What the company sees about its own invoice. Never the student's side. */
export type CompanyInvoiceStatus = 'not_sent' | 'sent' | 'overdue' | 'paid'
export function companyInvoiceStatus(
  days: Pick<PaymentDays, 'invoiceSent' | 'invoicePaid'>,
  today: string,
): CompanyInvoiceStatus {
  if (days.invoicePaid) return 'paid'
  if (days.invoiceSent) return today > dueDay(days.invoiceSent)! ? 'overdue' : 'sent'
  return 'not_sent'
}

/** Price, VAT and total for a row, or null when the price is missing. */
export const rowAmounts = (price: number | null | undefined): PriceBreakdown | null =>
  isValidPrice(price) ? priceBreakdown(price) : null

/** Why the team could not save a row. Each has its own message in both languages. */
export const PAYMENT_ERRORS = [
  'forbidden',
  'not_found',
  /** Someone else saved the row first: load it again. */
  'not_open',
  /** An unpaid project has no payment rows. */
  'unpaid',
  /** A date in the future. */
  'future',
  /** The company cannot pay before the invoice is sent. */
  'paid_before_sent',
  /** The student is paid only after the company paid. */
  'student_before_company',
  'bad_date',
  'too_long',
  'generic',
] as const
export type PaymentError = (typeof PAYMENT_ERRORS)[number]

export type PaymentFormState =
  | { status: 'idle' }
  | { status: 'saved'; doneAt: number }
  | { status: 'error'; error: PaymentError; doneAt: number }

export const PAYMENT_IDLE: PaymentFormState = { status: 'idle' }

/**
 * The order rules for the dates: the company pays after the invoice is sent, the student is paid
 * after the company paid, and nothing is recorded ahead of today. Returns the first problem.
 */
export function datesProblem(days: PaymentDays, today: string): PaymentError | null {
  for (const day of [days.invoiceSent, days.invoicePaid, days.studentPaid]) {
    if (day && day > today) return 'future'
  }
  if (days.invoicePaid && (!days.invoiceSent || days.invoicePaid < days.invoiceSent))
    return 'paid_before_sent'
  if (days.studentPaid && (!days.invoicePaid || days.studentPaid < days.invoicePaid))
    return 'student_before_company'
  return null
}

/** Read an error code a hook put on an APIError (`data.code`), through any wrapping. */
export function paymentErrorCode(error: unknown): PaymentError | undefined {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined
    if (typeof code === 'string' && (PAYMENT_ERRORS as readonly string[]).includes(code))
      return code as PaymentError
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
