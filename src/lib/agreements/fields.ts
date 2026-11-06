/**
 * Agreements: the shared words. Konnected writes the legal text in Word templates; the app only
 * fills in the fields listed here (konnected-agreements). Keep this file free of server imports:
 * the team screens show the field list too.
 */

export const AGREEMENT_KINDS = ['company', 'student'] as const
export type AgreementKind = (typeof AGREEMENT_KINDS)[number]

/** A template is uploaded as a draft, published (one per kind), then retired by a newer one. */
export const TEMPLATE_STATUSES = ['draft', 'published', 'retired'] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

/**
 * An agreement's life. Only the server moves it, as the result of generating or a signature:
 * generating -> awaiting_party (the company or the student signs) -> awaiting_konnected
 * (Konnected signs last) -> signed. `failed` when the PDF could not be made, `void` when the team
 * withdrew it before it was complete (a new one replaces it). A signed agreement never changes.
 */
export const AGREEMENT_STATUSES = [
  'generating',
  'awaiting_party',
  'awaiting_konnected',
  'signed',
  'failed',
  'void',
] as const
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]

/** Statuses the team may withdraw (void). Never a signed agreement. */
export const VOIDABLE: readonly AgreementStatus[] = [
  'generating',
  'awaiting_party',
  'awaiting_konnected',
  'failed',
]

/** Who signs. The company or the student first, Konnected last. */
export const SIGNATURE_PARTIES = ['company', 'student', 'konnected'] as const
export type SignatureParty = (typeof SIGNATURE_PARTIES)[number]

/**
 * How the signer had signed in to the session they signed with. `unknown` for a session that
 * does not say (one started before this was recorded).
 */
export const SIGN_IN_METHODS = ['google', 'email_link', 'password', 'unknown'] as const
export type SignInMethodUsed = (typeof SIGN_IN_METHODS)[number]

/**
 * The version of the tick-box text ("I have read and agree"), stored on every signature. Change
 * it whenever the wording in the message files changes.
 */
export const TICK_TEXT_VERSION = '2026-11-06'

/** The longest typed name a signature takes. */
export const NAME_MAX = 120

/** VAT on Konnected's fixed price (owner decision, 6 Nov 2026) and the payment terms. */
export const VAT_RATE = 0.25
export const PAYMENT_TERMS_DAYS = 14

/**
 * The fields a template may use, written `{{project.title}}` in the Word file. Anything else is
 * refused at upload, and a field without a value stops the agreement from being made (the team
 * sees which one).
 *
 * The company agreement never holds student data. The student agreement never holds the company's
 * price (students do not see it).
 */
const COMMON_FIELDS = [
  'agreement.date',
  'agreement.reference',
  'project.title',
  'project.description',
  'project.tasks',
  'project.deliverable',
  'project.workload',
  'project.timeframe',
  'project.deadline',
  'project.payment',
  'company.name',
  'company.orgNumber',
] as const

const COMPANY_ONLY_FIELDS = [
  'company.contactName',
  'price.exclVat',
  'price.vatRate',
  'price.vat',
  'price.total',
  'payment.termsDays',
] as const

const STUDENT_ONLY_FIELDS = ['student.fullName', 'project.startDate', 'project.dueDate'] as const

export type TemplateField =
  | (typeof COMMON_FIELDS)[number]
  | (typeof COMPANY_ONLY_FIELDS)[number]
  | (typeof STUDENT_ONLY_FIELDS)[number]

export const TEMPLATE_FIELDS: Record<AgreementKind, readonly TemplateField[]> = {
  company: [...COMMON_FIELDS, ...COMPANY_ONLY_FIELDS],
  student: [...COMMON_FIELDS, ...STUDENT_ONLY_FIELDS],
}

/** Every field of any kind, for the message files (labels per field). */
export const ALL_TEMPLATE_FIELDS: readonly TemplateField[] = [
  ...COMMON_FIELDS,
  ...COMPANY_ONLY_FIELDS,
  ...STUDENT_ONLY_FIELDS,
]

/** The message key for a field's label: dots are nesting in next-intl, so use underscores. */
export const fieldMessageKey = (field: string): string => field.replace(/\./g, '_')

/** Placeholders are written with double braces: `{{project.title}}`. */
export const DELIMITERS = { start: '{{', end: '}}' } as const

/** Upload limits for a template (.docx only). */
export const TEMPLATE_MAX_BYTES = 5 * 1024 * 1024
/** Largest total size of the files inside the .docx once unzipped (stops zip bombs). */
export const TEMPLATE_MAX_UNZIPPED_BYTES = 25 * 1024 * 1024
/** Most files inside one .docx. A real agreement has a few dozen. */
export const TEMPLATE_MAX_ENTRIES = 300

/** Why a template upload was refused. The team screen shows each in EN and NO. */
export type TemplateProblem =
  | { code: 'not_docx' }
  | { code: 'too_large' }
  | { code: 'unzipped_too_large' }
  | { code: 'too_many_parts' }
  | { code: 'broken_file' }
  | { code: 'macros' }
  | { code: 'malformed'; tags: string[] }
  | { code: 'unknown_fields'; tags: string[] }
  | { code: 'not_allowed_here'; tags: string[] }
  | { code: 'logic_tags'; tags: string[] }
  | { code: 'no_fields' }

/** The fields an agreement needs that have no value yet, for the team. */
export type MissingValues = { code: 'missing_values'; fields: string[] }
