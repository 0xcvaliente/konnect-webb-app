import { createHash, pbkdf2, randomBytes } from 'node:crypto'

import type { Payload, PayloadRequest } from 'payload'

import { PASSWORD_MAX, PASSWORD_MIN } from './passwordRules'

export { PASSWORD_MAX, PASSWORD_MIN }

/**
 * Password rules (owner decision, 5 Nov 2026; NIST SP 800-63B):
 * - at least 15 characters, up to 256, counted as characters (not bytes), spaces allowed;
 * - no composition rules, no hints, paste and password managers allowed;
 * - not in a list of breached passwords. The check uses the Have I Been Pwned range API with
 *   k-anonymity: only the first 5 hex characters of the SHA-1 hash leave the server, and the
 *   `Add-Padding` header hides the size of the answer. If the service cannot be reached the
 *   password is allowed (fail open) and a log line without personal data is written.
 */
export type PasswordProblem = 'too_short' | 'too_long' | 'breached'

const HIBP_RANGE = 'https://api.pwnedpasswords.com/range/'
const HIBP_TIMEOUT_MS = 3000

type Logger = Pick<Payload['logger'], 'warn'>

/** Length in characters (code points), so an emoji counts once. */
export const passwordLength = (password: string): number => [...password].length

export function passwordLengthProblem(password: string): PasswordProblem | null {
  const length = passwordLength(password)
  if (length < PASSWORD_MIN) return 'too_short'
  if (length > PASSWORD_MAX) return 'too_long'
  return null
}

/** True when the password appears in a known breach. False when it does not, or on any error. */
export async function isBreachedPassword(password: string, logger?: Logger): Promise<boolean> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase()
  const prefix = sha1.slice(0, 5)
  const suffix = sha1.slice(5)
  try {
    const response = await fetch(`${HIBP_RANGE}${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'Konnected-web-app' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`status ${response.status}`)
    const body = await response.text()
    for (const line of body.split('\n')) {
      const [hashSuffix, count] = line.trim().split(':')
      // Padding lines have a count of 0.
      if (hashSuffix === suffix && Number(count) > 0) return true
    }
    return false
  } catch (error) {
    // Fail open. The log line names the failure only: no password, hash, prefix or user.
    logger?.warn({
      msg: 'Breached-password check unavailable; the password was allowed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }
}

/** Every password rule, in order: length first, then the breach list. */
export async function passwordProblem(
  password: string,
  logger?: Logger,
): Promise<PasswordProblem | null> {
  return (
    passwordLengthProblem(password) ??
    ((await isBreachedPassword(password, logger)) ? 'breached' : null)
  )
}

const FIELD_MESSAGES: Record<PasswordProblem, string> = {
  too_short: `Use at least ${PASSWORD_MIN} characters.`,
  too_long: `Use at most ${PASSWORD_MAX} characters.`,
  breached: 'This password has appeared in a data breach. Choose another one.',
}

/**
 * Context flags server code sets on `req.context`:
 * - `passwordChecked`: the sign-up or reset code already ran every rule on this password;
 * - `generatedPassword`: the server made a random password nobody knows (Google and email-link
 *   accounts), so the breach check is skipped.
 */
export type PasswordContext = { passwordChecked?: boolean; generatedPassword?: boolean }

/**
 * The `validate` of the `password` field on `users`. Payload runs it on create, on update and on
 * reset-password, for REST, GraphQL, the admin panel and the Local API.
 */
export async function validatePassword(
  value: unknown,
  { req, event }: { req: PayloadRequest; event?: 'onChange' | 'submit' },
): Promise<string | true> {
  // No new password in this write (for example an update of another field).
  if (value === undefined || value === null || value === '') return true
  if (typeof value !== 'string') return FIELD_MESSAGES.too_short
  const lengthProblem = passwordLengthProblem(value)
  if (lengthProblem) return FIELD_MESSAGES[lengthProblem]
  const context = req.context as PasswordContext
  // The admin form validates while typing; the breach check waits for the save.
  if (event === 'onChange' || context.passwordChecked || context.generatedPassword) return true
  return (await isBreachedPassword(value, req.payload.logger)) ? FIELD_MESSAGES.breached : true
}

/**
 * Hash a throwaway password with the same cost as a real check. Used where no password hash runs
 * (unknown email, locked account, existing account on sign-up), so the answer takes as long as
 * a real one and the timing does not show whether an account exists.
 */
export function dummyPasswordHash(payload: Payload): Promise<void> {
  const iterations = payload.config.auth.passwordHashIterations
  return new Promise((resolve) =>
    pbkdf2('not-a-real-password', randomBytes(32), iterations, 32, 'sha256', () => resolve()),
  )
}
