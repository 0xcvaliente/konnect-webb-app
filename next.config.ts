import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import path from 'path'
import { fileURLToPath } from 'url'

import { LEGACY_TEAM_REDIRECTS } from './src/lib/legacyRedirects'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/**
 * Browser rules for every response. Our own pages (/en, /no) get a full content security policy
 * with a nonce from src/proxy.ts, which replaces the short one below. /admin and /api keep it.
 */
const securityHeaders = [
  // HTTPS only, for two years, once the site is served over HTTPS.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // No other site may show our pages in a frame.
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

const nextConfig: NextConfig = {
  // CLAUDE.md is the agent instruction file. Stop `next dev` from generating AGENTS.md.
  agentRules: false,
  poweredByHeader: false,
  // Production runs from Docker: a self-contained server.js with only the files it needs. The
  // Dockerfile adds public/ and .next/static, which standalone output leaves out.
  output: 'standalone',
  async redirects() {
    return LEGACY_TEAM_REDIRECTS
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Private files (CVs, deliverables, brief attachments, agreements and their templates): nothing in them may run or load
      // anything, even if a browser opened one. Later rules win for the same header, so this
      // replaces the policy above for these routes only. The download headers themselves come
      // from the collections (lib/uploads/fileRules.ts).
      {
        source:
          '/api/:collection(cvs|deliverable-files|brief-files|agreement-pdfs|agreement-templates)/file/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; frame-ancestors 'none'; sandbox",
          },
        ],
      },
    ]
  },
  // Payload source files import with ".js" extensions that resolve to ".ts" files.
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(withNextIntl(nextConfig), { devBundleServerPackages: false })
