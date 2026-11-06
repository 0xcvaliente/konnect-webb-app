/*
 * Menu items for the two layouts. Most routes do not exist yet; they are placeholders until the
 * dashboard cards build them. Labels come from the "Shell" messages in src/messages/{en,no}.json.
 * The team workspace lives at /{locale}/team (owner decision); Payload's own admin panel stays
 * at /admin as a fallback, and /{locale}/admin/... redirects to /{locale}/team/... (next.config).
 */

export const SITE_NAV = {
  student: [
    { key: 'home', href: '/student' },
    { key: 'projects', href: '/student/projects' },
    { key: 'applications', href: '/student/applications' },
    { key: 'payments', href: '/student/payments' },
  ],
  company: [
    { key: 'status', href: '/company' },
    { key: 'projects', href: '/company/projects' },
    { key: 'submit', href: '/company/projects/new' },
    { key: 'payments', href: '/company/payments' },
  ],
} as const

export type SiteRole = keyof typeof SITE_NAV
export type SiteNavKey = (typeof SITE_NAV)[SiteRole][number]['key']

export const PROFILE_HREF: Record<SiteRole, string> = {
  student: '/student/profile',
  company: '/company/profile',
}

export const TEAM_NAV = [
  {
    group: 'daily',
    items: [
      { key: 'today', href: '/team' },
      { key: 'approvals', href: '/team/approvals' },
      { key: 'matching', href: '/team/matching' },
      { key: 'agreements', href: '/team/agreements' },
      { key: 'deliverables', href: '/team/deliverables' },
      { key: 'questions', href: '/team/questions' },
      { key: 'payments', href: '/team/payments' },
    ],
  },
  {
    group: 'records',
    items: [
      { key: 'directory', href: '/team/directory' },
      { key: 'users', href: '/team/users' },
      { key: 'dataRequests', href: '/team/data-requests' },
    ],
  },
  {
    group: 'settings',
    items: [
      { key: 'team', href: '/team/members' },
      { key: 'templates', href: '/team/agreements/templates' },
    ],
  },
] as const

export type TeamNavKey = (typeof TEAM_NAV)[number]['items'][number]['key']
