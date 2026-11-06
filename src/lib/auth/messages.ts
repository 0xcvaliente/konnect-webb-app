/** Sign-in error codes and their messages in English and Norwegian. No account details inside. */
export type AuthErrorCode =
  | 'cancelled'
  | 'google_error'
  | 'unverified_email'
  | 'session_expired'
  | 'too_many_requests'
  | 'account_conflict'

export const AUTH_MESSAGES: Record<AuthErrorCode, { en: string; no: string }> = {
  cancelled: {
    en: 'Sign-in was cancelled. You can try again.',
    no: 'Innloggingen ble avbrutt. Du kan prøve igjen.',
  },
  google_error: {
    en: 'Google could not sign you in. Please try again.',
    no: 'Google kunne ikke logge deg inn. Prøv igjen.',
  },
  unverified_email: {
    en: 'Your Google account has no verified email address, so we cannot sign you in.',
    no: 'Google-kontoen din har ingen bekreftet e-postadresse, så vi kan ikke logge deg inn.',
  },
  session_expired: {
    en: 'The sign-in took too long or was interrupted. Please start again.',
    no: 'Innloggingen tok for lang tid eller ble avbrutt. Start på nytt.',
  },
  too_many_requests: {
    en: 'Too many attempts. Please wait a minute and try again.',
    no: 'For mange forsøk. Vent ett minutt og prøv igjen.',
  },
  account_conflict: {
    en: 'This email is already linked to a different Google account. Contact Konnected.',
    no: 'Denne e-posten er allerede koblet til en annen Google-konto. Kontakt Konnected.',
  },
}

export const isAuthErrorCode = (value: string | undefined): value is AuthErrorCode =>
  Boolean(value) && value! in AUTH_MESSAGES

/** Pick Norwegian for nb/nn/no browsers, English for everything else. */
export function pickLanguage(acceptLanguage: string | null | undefined): 'en' | 'no' {
  const first = acceptLanguage?.split(',')[0]?.trim().toLowerCase() ?? ''
  return /^(no|nb|nn)(-|$)/.test(first) ? 'no' : 'en'
}
