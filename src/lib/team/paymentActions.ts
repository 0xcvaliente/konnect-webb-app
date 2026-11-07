'use server'

import config from '@payload-config'
import { headers } from 'next/headers'
import { getPayload } from 'payload'

import type { PaymentFormState } from '@/lib/payments/fields'

import type { SessionUser } from './approvals'
import { savePayment } from './payments'

/**
 * Server Action for the team's payment log. A public POST endpoint, so it reads the session again
 * here; the Payments access rules (admin only) and hook (the dates) decide.
 */
export async function savePaymentAction(
  _prev: PaymentFormState,
  form: FormData,
): Promise<PaymentFormState> {
  const payload = await getPayload({ config })
  const { user } = await payload.auth({ headers: await headers() })
  return savePayment(payload, (user as SessionUser | null) ?? null, form)
}
