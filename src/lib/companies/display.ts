import type { SiteNavKey } from '@/components/app/nav'
import { accountMenuUser } from '@/lib/account'
import type { Company } from '@/payload-types'

import type { SessionUser } from './company'
import type { CompanyStatusKey } from './fields'

/** The pill tone for each company status (konnected-design-system, status pills). */
export const STATUS_TONE: Record<CompanyStatusKey, 'warn' | 'ok' | 'bad'> = {
  pending: 'warn',
  approved: 'ok',
  rejected: 'bad',
}

/**
 * Menu items a company cannot open yet. A pending company may already write draft projects
 * (owner decision), so only payments wait for approval. A company Konnected did not approve can
 * still read its projects but not start new ones.
 */
const LOCKED: Record<CompanyStatusKey, readonly SiteNavKey[]> = {
  pending: ['payments'],
  approved: [],
  rejected: ['submit', 'payments'],
}

/** The SiteShell settings every company page shares: the menu, what is locked, the account. */
export function companyShellProps(user: SessionUser, company: Company) {
  return {
    role: 'company' as const,
    locked: LOCKED[company.status],
    // The account's name is the contact person's (copied from the company by a hook).
    user: accountMenuUser({
      name: user.name || company.contactName || company.name,
      email: user.email,
    }),
  }
}
