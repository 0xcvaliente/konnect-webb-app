import { type Payload, ValidationError } from 'payload'

import { companyIdOf, isCompany, relationId } from '@/access/roles'
import { LOCKED_AFTER_APPROVAL } from '@/collections/Companies'
import type { Company, User } from '@/payload-types'

import {
  COMPANY_FIELDS,
  type CompanyField,
  type CompanyFieldErrors,
  type CompanyFormState,
  isValidOrgNumber,
  LIMITS,
  normalizeOrgNumber,
  normalizeWebsite,
  SECTOR_KEYS,
  type SectorKey,
} from './fields'

/**
 * The company user's own company: registration (the onboarding) and edits on the profile page.
 * Plain functions over Payload so they can be tested without a request; the Server Actions in
 * actions.ts call them with the signed-in user.
 *
 * Every write goes through the Local API as that user with `overrideAccess: false`, so the
 * collection's access rules and hooks decide: only a company user, only their own company, one
 * company per user, never the status, and only a logo they uploaded. The checks here come first
 * only to give clear answers. Nothing here logs form values.
 */

export type SessionUser = User & { collection: 'users' }

type Result = CompanyFormState

const ok = (): Result => ({ status: 'done', savedAt: Date.now() })
const fail = (error: NonNullable<Result['error']>): Result => ({ status: 'error', error })
const invalid = (fields: CompanyFieldErrors): Result => ({ status: 'error', fields })

const text = (form: FormData, name: string): string => {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

type Details = Pick<
  Company,
  'name' | 'orgNumber' | 'contactName' | 'contactRole' | 'website' | 'sector' | 'description'
>

/** Every question of the onboarding and the profile form, checked like the collection does. */
function readDetails(form: FormData, errors: CompanyFieldErrors): Details {
  const required = (
    name: 'name' | 'contactName' | 'contactRole' | 'description',
    max: number,
  ): string => {
    const value = text(form, name)
    if (!value) errors[name] = 'required'
    else if (value.length > max) errors[name] = 'too_long'
    return value
  }
  const name = required('name', LIMITS.name)
  const contactName = required('contactName', LIMITS.contactName)
  const contactRole = required('contactRole', LIMITS.contactRole)
  const description = required('description', LIMITS.description)

  const orgNumber = normalizeOrgNumber(text(form, 'orgNumber'))
  if (!orgNumber) errors.orgNumber = 'required'
  else if (!isValidOrgNumber(orgNumber)) errors.orgNumber = 'invalid'

  const websiteText = text(form, 'website')
  let website: string | null = null
  if (websiteText.length > LIMITS.website) errors.website = 'too_long'
  else if (websiteText) {
    website = normalizeWebsite(websiteText)
    if (!website || website.length > LIMITS.website) errors.website = 'invalid'
  }

  const sectorText = text(form, 'sector')
  const sector = (SECTOR_KEYS as readonly string[]).includes(sectorText)
    ? (sectorText as SectorKey)
    : null
  if (!sector) errors.sector = sectorText ? 'invalid' : 'required'

  return { name, orgNumber, contactName, contactRole, website, sector, description }
}

/** A logo id from the form: a positive whole number, `null` for none, or `undefined` if invalid. */
function readLogoId(form: FormData): number | null | undefined {
  const value = text(form, 'logo')
  if (!value || value === 'none') return null
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

/** The signed-in company user's own company, read as that user. */
export async function findOwnCompany(
  payload: Payload,
  user: SessionUser,
  depth = 0,
): Promise<Company | null> {
  const companyId = companyIdOf(user)
  if (!companyId) return null
  const found = await payload.find({
    collection: 'companies',
    where: { id: { equals: companyId } },
    limit: 1,
    depth,
    user,
    overrideAccess: false,
  })
  return found.docs[0] ?? null
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

/** True when Postgres refused a second company for the same user (unique index on `user`). */
const isDuplicate = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ((current as { code?: unknown }).code === '23505') return true
    const { message } = current as { message?: unknown }
    if (typeof message === 'string' && /unique|already|duplicate/i.test(message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

const isCompanyField = (path: string): path is CompanyField =>
  (COMPANY_FIELDS as readonly string[]).includes(path)

/**
 * A save Payload refused, as an answer for the page. A Server Action that throws sends the user
 * to an error page and loses every unsaved edit, so it never does: a ValidationError on a form
 * field marks that field, anything else is a general error. The log line has no form values.
 */
function refused(payload: Payload, error: unknown): Result {
  if (error instanceof ValidationError) {
    const fields: CompanyFieldErrors = {}
    for (const { path } of error.data.errors) if (isCompanyField(path)) fields[path] = 'invalid'
    if (Object.keys(fields).length) return invalid(fields)
  }
  payload.logger.error({
    msg: 'Company save failed',
    reason: error instanceof Error ? error.name : 'unknown',
  })
  return fail('generic')
}

/** Remove a logo the company no longer uses. Best effort: the daily clean-up catches the rest. */
async function removeOldLogo(payload: Payload, user: SessionUser, id: number | undefined) {
  if (!id) return
  try {
    await payload.delete({ collection: 'company-logos', id, user, overrideAccess: false })
  } catch {
    // Not removable now (for example still copied on a project). The clean-up job handles it.
  }
}

/**
 * The onboarding's last step: register the company with every answer. Only a company user
 * without a company can do this, once. The company starts pending and is linked to the user.
 */
export async function registerCompany(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isCompany(user)) return fail('forbidden')

  const errors: CompanyFieldErrors = {}
  const details = readDetails(form, errors)
  const logo = readLogoId(form)
  if (logo === undefined) errors.logo = 'invalid'
  if (Object.keys(errors).length) return invalid(errors)

  if (companyIdOf(user)) return fail('exists')

  try {
    await payload.create({
      collection: 'companies',
      // The collection makes every new company pending, whatever is sent.
      data: { ...details, logo: logo ?? null, status: 'pending' },
      user,
      overrideAccess: false,
    })
  } catch (error) {
    if (statusOf(error) === 403 && logo) return invalid({ logo: 'invalid' })
    if (isDuplicate(error) || statusOf(error) === 403) return fail('exists')
    return refused(payload, error)
  }
  return ok()
}

/**
 * Save the profile page's form. While the company is pending every field can change; once
 * Konnected approved it, the name and organisation number stay as they were checked. A rejected
 * company cannot change anything here.
 */
export async function saveCompany(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<Result> {
  if (!user || !isCompany(user)) return fail('forbidden')
  const company = await findOwnCompany(payload, user)
  if (!company) return fail('no_company')
  if (company.status !== 'pending' && company.status !== 'approved') return fail('not_editable')

  const errors: CompanyFieldErrors = {}
  const details: Partial<Details> = readDetails(form, errors)
  const logo = readLogoId(form)
  if (logo === undefined) errors.logo = 'invalid'
  // After approval the name and organisation number are not sent at all (the page shows them
  // read-only). A different value in the form is refused rather than silently ignored.
  if (company.status !== 'pending') {
    for (const key of LOCKED_AFTER_APPROVAL) {
      const sent = form.has(key) ? details[key] : undefined
      delete errors[key]
      delete details[key]
      if (sent && sent !== (company[key] ?? '')) errors[key] = 'locked'
    }
  }
  if (Object.keys(errors).length) return invalid(errors)

  const previousLogo = relationId(company.logo)
  try {
    const data: Partial<Company> = { ...details, logo }
    await payload.update({
      collection: 'companies',
      id: company.id,
      data,
      user,
      overrideAccess: false,
    })
  } catch (error) {
    if (statusOf(error) === 403 && logo) return invalid({ logo: 'invalid' })
    if (statusOf(error) === 403 || statusOf(error) === 404) return fail('not_editable')
    return refused(payload, error)
  }
  if (previousLogo && previousLogo !== logo) await removeOldLogo(payload, user, previousLogo)
  return ok()
}
