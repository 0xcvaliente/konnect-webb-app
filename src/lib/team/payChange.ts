/**
 * Changing a project's price and the student's pay after it was published (owner answer 42), from
 * the team's project page. Plain values and types only, so the client form and the server share
 * them. The Projects collection holds the rules (only admins write either field, the pay is at most
 * the price) and logs each change with the old and new amount and who made it.
 */

/** Project statuses in which the team changes the price and pay here (after publishing). */
export const PAY_EDITABLE = ['published', 'matched', 'in_progress', 'delivered'] as const

/** Agreement statuses in which the company or the student has signed already. */
export const PARTY_SIGNED = ['awaiting_konnected', 'signed'] as const

export const PAY_CHANGE_ERRORS = [
  'forbidden',
  'not_found',
  /** Not a paid project, or not in a status where the price changes here. */
  'not_open',
  'price_invalid',
  'student_pay_invalid',
  /** The form changes nothing. */
  'same',
  /** The price or pay changed since the form loaded. */
  'changed',
  /** A signed agreement exists and the team did not confirm it keeps the old amount. */
  'confirm',
  'generic',
] as const
export type PayChangeError = (typeof PAY_CHANGE_ERRORS)[number]

export type PayChangeState =
  | { status: 'idle' }
  | { status: 'done'; doneAt: number }
  | { status: 'error'; error: PayChangeError; doneAt: number }

export const PAY_CHANGE_IDLE: PayChangeState = { status: 'idle' }
