/*
 * Menu items for the two layouts. The routes do not exist yet; they are placeholders until the
 * dashboard cards build them. Labels come from the "Shell" messages in src/messages/{en,no}.json.
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
      { key: 'today', href: '/admin' },
      { key: 'approvals', href: '/admin/approvals' },
      { key: 'matching', href: '/admin/matching' },
      { key: 'agreements', href: '/admin/agreements' },
      { key: 'deliverables', href: '/admin/deliverables' },
      { key: 'questions', href: '/admin/questions' },
      { key: 'payments', href: '/admin/payments' },
    ],
  },
  {
    group: 'records',
    items: [
      { key: 'directory', href: '/admin/directory' },
      { key: 'dataRequests', href: '/admin/data-requests' },
    ],
  },
  {
    group: 'settings',
    items: [
      { key: 'team', href: '/admin/team' },
      { key: 'templates', href: '/admin/agreements/templates' },
    ],
  },
] as const

export type TeamNavKey = (typeof TEAM_NAV)[number]['items'][number]['key']
