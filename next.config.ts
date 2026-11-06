import { withPayload } from '@payloadcms/next/withPayload'
import type { NextConfig } from 'next'
import createNextIntlPlugin from 'next-intl/plugin'
import path from 'path'
import { fileURLToPath } from 'url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/**
 * Browser rules for every response. A content security policy with nonces for our own pages comes
 * with the design base, once the pages load real scripts and styles.
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
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
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
