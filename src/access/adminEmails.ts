/**
 * The ADMIN_EMAILS allowlist. `admin` can only be granted to a verified email on this list.
 * Read on every call so tests and deploys can change it without a rebuild.
 */
export const adminEmails = (): string[] =>
  (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

export const isAdminEmail = (email: string | null | undefined): boolean =>
  Boolean(email) && adminEmails().includes((email as string).trim().toLowerCase())
