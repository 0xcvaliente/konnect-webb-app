import { isAdminEmail } from '@/access/adminEmails'

type ResetUser = { email?: string | null; role?: string | null; language?: string | null }

/**
 * Admins sign in with Google only, so they never get a reset link. They still get an email, built
 * and sent exactly like everyone else's, so the answer and its timing do not reveal which
 * addresses are admins. The stored token is never shown to anyone.
 */
const isAdminAccount = (user?: ResetUser): boolean =>
  user?.role === 'admin' || isAdminEmail(user?.email ?? undefined)

const lang = (user?: ResetUser): 'en' | 'no' => (user?.language === 'no' ? 'no' : 'en')

const TEXT = {
  en: {
    subject: 'Reset your Konnected password',
    reset:
      'Someone asked to reset the password for this Konnected account. Use this link within an hour. It works once.',
    button: 'Choose a new password',
    admin:
      'Someone asked to reset the password for this Konnected account. Konnected team accounts sign in with Google, so there is no password to reset.',
    ignore: 'If you did not ask for this, ignore this email. Nothing has changed.',
  },
  no: {
    subject: 'Tilbakestill passordet ditt hos Konnected',
    reset:
      'Noen ba om å tilbakestille passordet for denne Konnected-kontoen. Bruk lenken innen en time. Den virker én gang.',
    button: 'Velg nytt passord',
    admin:
      'Noen ba om å tilbakestille passordet for denne Konnected-kontoen. Kontoer i Konnected-teamet logger inn med Google, så det finnes ikke noe passord å tilbakestille.',
    ignore: 'Hvis det ikke var deg, kan du se bort fra denne e-posten. Ingenting er endret.',
  },
}

export const resetEmailSubject = ({ user }: { user?: ResetUser } = {}): string =>
  TEXT[lang(user)].subject

export function resetEmailHTML({ token, user }: { token?: string; user?: ResetUser } = {}): string {
  const t = TEXT[lang(user)]
  if (isAdminAccount(user) || !token) return `<p>${t.admin}</p><p>${t.ignore}</p>`
  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  // The reset page arrives with the password sign-in card.
  const link = `${appUrl}/${lang(user)}/reset-password/${encodeURIComponent(token)}`
  return `<p>${t.reset}</p><p><a href="${link}">${t.button}</a></p><p>${t.ignore}</p>`
}
