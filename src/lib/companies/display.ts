import type { SiteNavKey } from '@/components/app/nav'
import type { Company } from '@/payload-types'

import type { SessionUser } from './company'
import type { CompanyStatusKey } from './fields'

/** The pill tone for each company status (konnected-design-system, status pills). */
export const STATUS_TONE: Record<CompanyStatusKey, 'warn' | 'ok' | 'bad'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'bad',
}

/** Menu items a company cannot open before Konnected approves it. */
const LOCKED_UNTIL_APPROVED: readonly SiteNavKey[] = ['projects', 'submit', 'payments']

/** The SiteShell settings every company page shares: the menu, what is locked, the account. */
export function companyShellProps(user: SessionUser, company: Company) {
  return {
    role: 'company' as const,
    locked: company.status === 'approved' ? [] : LOCKED_UNTIL_APPROVED,
    user: { name: company.contactName || company.name, detail: user.email },
  }
}
