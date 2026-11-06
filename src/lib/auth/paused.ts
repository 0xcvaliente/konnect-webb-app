import { APIError } from 'payload'

/**
 * A paused account tried to sign in. Thrown by the Users `beforeLogin` hook (after Payload has
 * checked the password, so only the person who knows it learns the account is paused) and by
 * createSessionToken (Google and email links, which already proved the address).
 */
export class AccountPausedError extends APIError {
  constructor() {
    super('This account is paused. Write to Konnected if you think this is a mistake.', 403)
    this.name = 'AccountPaused'
  }
}

export const isPaused = (user: { accountStatus?: string | null } | null | undefined): boolean =>
  user?.accountStatus === 'paused'
