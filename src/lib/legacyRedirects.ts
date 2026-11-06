/**
 * The team workspace moved from /{locale}/admin to /{locale}/team (owner decision). Old links and
 * bookmarks keep working through these redirects, used in next.config.ts. Temporary (307) so the
 * address can be reused later. Payload's own admin panel at /admin (no language) is not touched.
 * The language list must match src/i18n/routing.ts (a test checks it).
 */
export const LEGACY_LOCALES = ['en', 'no'] as const

const locales = LEGACY_LOCALES.join('|')

export const LEGACY_TEAM_REDIRECTS = [
  { source: `/:locale(${locales})/admin`, destination: '/:locale/team', permanent: false },
  {
    source: `/:locale(${locales})/admin/:path*`,
    destination: '/:locale/team/:path*',
    permanent: false,
  },
]
