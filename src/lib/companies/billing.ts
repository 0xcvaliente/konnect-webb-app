import type { Payload } from 'payload'

import { companyIdOf, isAdmin, isCompany } from '@/access/roles'
import type { Company } from '@/payload-types'

import type { SessionUser } from './company'
import { BILLING_LIMITS, type BillingFormState, type BillingValues, isEmailAddress } from './fields'

/**
 * Billing details (Kanban card "Billing details for invoices"): the invoice email, the reference
 * on every invoice, and e-invoice (EHF) yes or no. The company edits its own on the profile page;
 * the team edits any company's in the payment log. Every write goes through the Local API as the
 * signed-in user with `overrideAccess: false`; the Companies access rules and hook decide (a
 * company edits its own while pending or approved, and a billing-only save never counts as an
 * answer to Konnected's review). Nothing here logs the values.
 */

const asUser = (user: SessionUser) => ({ user, overrideAccess: false as const })

/** The billing values stored on a company, for a form. */
export const billingOf = (company: Pick<Company, keyof BillingValues>): BillingValues => ({
  invoiceEmail: company.invoiceEmail ?? '',
  invoiceReference: company.invoiceReference ?? '',
  ehfInvoice: Boolean(company.ehfInvoice),
})

/** The form's values, checked like the collection does. */
function readForm(form: FormData): { data: Partial<Company>; errors: BillingFormState['fields'] } {
  const text = (name: string) => {
    const value = form.get(name)
    return typeof value === 'string' ? value.trim() : ''
  }
  const errors: NonNullable<BillingFormState['fields']> = {}
  const invoiceEmail = text('invoiceEmail').toLowerCase()
  if (invoiceEmail.length > BILLING_LIMITS.invoiceEmail) errors.invoiceEmail = 'too_long'
  else if (invoiceEmail && !isEmailAddress(invoiceEmail)) errors.invoiceEmail = 'invalid'
  const invoiceReference = text('invoiceReference')
  if (invoiceReference.length > BILLING_LIMITS.invoiceReference)
    errors.invoiceReference = 'too_long'
  const ehf = form.get('ehfInvoice')
  return {
    data: {
      invoiceEmail: invoiceEmail || null,
      invoiceReference: invoiceReference || null,
      ehfInvoice: ehf === 'on' || ehf === 'true',
    },
    errors,
  }
}

const fail = (error: NonNullable<BillingFormState['error']>): BillingFormState => ({
  status: 'error',
  error,
  savedAt: Date.now(),
})

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : undefined

async function save(
  payload: Payload,
  user: SessionUser,
  companyId: number,
  form: FormData,
): Promise<BillingFormState> {
  const { data, errors } = readForm(form)
  if (errors && Object.keys(errors).length) {
    return { status: 'error', fields: errors, savedAt: Date.now() }
  }
  try {
    await payload.update({ collection: 'companies', id: companyId, data, ...asUser(user) })
  } catch (error) {
    const status = statusOf(error)
    if (status === 403) return fail('not_editable')
    if (status === 404) return fail('not_found')
    payload.logger.error({
      msg: 'Billing save failed',
      reason: error instanceof Error ? error.name : 'unknown',
    })
    return fail('generic')
  }
  return { status: 'done', savedAt: Date.now() }
}

/** The company user saves their own company's billing details. */
export async function saveOwnBilling(
  payload: Payload,
  user: SessionUser | null,
  form: FormData,
): Promise<BillingFormState> {
  if (!user || !isCompany(user)) return fail('forbidden')
  const companyId = companyIdOf(user)
  if (!companyId) return fail('not_found')
  return save(payload, user, companyId, form)
}

/** A team member saves any company's billing details (from the payment log). */
export async function saveCompanyBilling(
  payload: Payload,
  actor: SessionUser | null,
  form: FormData,
): Promise<BillingFormState> {
  if (!actor || !isAdmin(actor)) return fail('forbidden')
  const raw = form.get('companyId')
  const companyId = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : 0
  if (!companyId) return fail('not_found')
  return save(payload, actor, companyId, form)
}
