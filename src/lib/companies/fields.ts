/**
 * The company profile's answer options, limits and checks, shared by the onboarding, the profile
 * page, the server checks and the collection. Nothing here imports server code, so client
 * components can use it too. Labels live in the message files (CompanyFields).
 */

/** The sectors a company can pick (mockup "Company onboarding", Industry). Stored as these keys. */
export const SECTOR_KEYS = [
  'software',
  'food',
  'energy',
  'retail',
  'health',
  'media',
  'other',
] as const
export type SectorKey = (typeof SECTOR_KEYS)[number]

/** Konnected approves every company. New companies are pending; only Konnected moves them. */
export const COMPANY_STATUSES = ['pending', 'approved', 'rejected'] as const
export type CompanyStatusKey = (typeof COMPANY_STATUSES)[number]

export const LIMITS = {
  name: 120,
  contactName: 120,
  contactRole: 80,
  website: 200,
  description: 600,
} as const

/** A logo: PNG or JPG, 1 MB at most. */
export const LOGO_MAX_BYTES = 1024 * 1024

/** The organisation number without spaces, dots or dashes. Anything else is kept as typed. */
export const normalizeOrgNumber = (value: string): string => value.replace(/[\s.-]/g, '')

const ORG_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2]

/**
 * A Norwegian organisation number: nine digits whose last digit is the modulus 11 check digit of
 * the first eight (weights 3 2 7 6 5 4 3 2, as the Brønnøysund register uses). This only proves
 * the number is well formed; looking it up in the register is a later card.
 */
export function isValidOrgNumber(value: string): boolean {
  const digits = normalizeOrgNumber(value)
  if (!/^\d{9}$/.test(digits)) return false
  const sum = ORG_WEIGHTS.reduce((total, weight, i) => total + weight * Number(digits[i]), 0)
  const rest = sum % 11
  const check = rest === 0 ? 0 : 11 - rest
  return check !== 10 && check === Number(digits[8])
}

/** "923609016" as "923 609 016". */
export const formatOrgNumber = (value: string): string => {
  const digits = normalizeOrgNumber(value)
  return /^\d{9}$/.test(digits) ? digits.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3') : value
}

/**
 * A website as typed, made into a full address: "fjordfrukt.no" becomes "https://fjordfrukt.no".
 * Returns null for anything that is not an http or https address with a real host name, or that
 * carries a user name or password. Only these addresses are ever shown as links.
 */
export function normalizeWebsite(value: string): string | null {
  const raw = value.trim()
  if (!raw || /\s/.test(raw)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) return null
  const text = url.toString()
  // `new URL` adds a slash to a bare host. Keep the address as the company typed it.
  return url.pathname === '/' && !url.search && !url.hash && !withScheme.endsWith('/')
    ? text.replace(/\/$/, '')
    : text
}

/** The field names a company form can report a problem on. */
export const COMPANY_FIELDS = [
  'name',
  'orgNumber',
  'contactName',
  'contactRole',
  'website',
  'sector',
  'description',
  'logo',
] as const
export type CompanyField = (typeof COMPANY_FIELDS)[number]

export type CompanyFieldProblem = 'required' | 'too_long' | 'invalid' | 'locked'

export type CompanyFieldErrors = Partial<Record<CompanyField, CompanyFieldProblem>>

/** The answer a company Server Action gives the page. */
export type CompanyFormState = {
  status: 'idle' | 'done' | 'error'
  /** A problem with the whole request, not one field. */
  error?: 'forbidden' | 'exists' | 'no_company' | 'not_editable' | 'generic'
  fields?: CompanyFieldErrors
  /** Changes on every save, so the page can show "Saved" again after a second save. */
  savedAt?: number
}

export const IDLE: CompanyFormState = { status: 'idle' }

/**
 * Billing details on the company profile (Kanban card "Billing details for invoices", mockup
 * "Company profile", Billing): where Konnected sends invoices, the reference the company wants on
 * every invoice, and whether it takes e-invoices (EHF). The company and the team edit them; the
 * team sees them in the payment log. Konnected sends invoices by hand in the pilot.
 */
export const BILLING_FIELDS = ['invoiceEmail', 'invoiceReference', 'ehfInvoice'] as const
export type BillingField = (typeof BILLING_FIELDS)[number]

export const BILLING_LIMITS = { invoiceEmail: 254, invoiceReference: 80 } as const

/** A plain email address check (one @, a dot in the domain, no spaces). */
export const isEmailAddress = (value: string): boolean =>
  value.length <= BILLING_LIMITS.invoiceEmail && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

export type BillingValues = {
  invoiceEmail: string
  invoiceReference: string
  ehfInvoice: boolean
}

export type BillingFieldProblem = 'invalid' | 'too_long'

export type BillingFormState = {
  status: 'idle' | 'done' | 'error'
  error?: 'forbidden' | 'not_found' | 'not_editable' | 'generic'
  fields?: Partial<Record<'invoiceEmail' | 'invoiceReference', BillingFieldProblem>>
  savedAt?: number
}

export const BILLING_IDLE: BillingFormState = { status: 'idle' }
