import type { PayloadRequest } from 'payload'

import { appUrl } from '@/lib/auth/env'
import type { Company } from '@/payload-types'

import { companyRecipient } from './projectEmails'
import { type EmailType, sendEmail } from './send'
import { companyReviewEmail, type CompanyReviewKind } from './templates'

const TYPE: Record<CompanyReviewKind, EmailType> = {
  approved: 'company_approved',
  rejected: 'company_rejected',
  info_requested: 'company_info_requested',
}

/**
 * Tell the company what Konnected decided (owner decision: email the company when it is approved
 * or rejected), or that Konnected needs more information. The team's note goes with a rejection
 * or a request. Called from the Companies afterChange hook, so every API sends it.
 */
export async function sendCompanyReviewEmail(
  req: PayloadRequest,
  company: Pick<Company, 'id' | 'name' | 'noteToCompany' | 'resentAt'>,
  kind: CompanyReviewKind | Company['status'],
): Promise<void> {
  if (kind !== 'approved' && kind !== 'rejected' && kind !== 'info_requested') return
  const to = await companyRecipient(req, company.id)
  if (!to) return
  const base = `${appUrl()}/${to.locale}`
  await sendEmail(req.payload, {
    to: to.email,
    email: companyReviewEmail(to.locale, kind, {
      name: company.name,
      note: company.noteToCompany,
      canResend: !company.resentAt,
      href: kind === 'approved' ? `${base}/company/projects/new` : `${base}/company/profile`,
    }),
    type: TYPE[kind],
    userId: to.id,
  })
}
