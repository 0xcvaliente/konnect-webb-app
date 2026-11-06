import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

import { testDatabaseUrl } from './tests/setup/env'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/setup/global.ts'],
    // One database, so run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    // next-intl imports "next/server" without ".js", which Node's ESM loader cannot resolve. Let
    // Vite bundle it so the proxy can be tested.
    server: { deps: { inline: ['next-intl'] } },
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: testDatabaseUrl(),
      PAYLOAD_SECRET: 'test-only-secret-not-used-anywhere-else',
      ADMIN_EMAILS: 'admin@konnected.test',
      // Fixed values so tests never use the real Google client from a developer's .env.
      APP_URL: 'http://localhost:3000',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret-not-real',
      // No SMTP in tests: email is built but sent nowhere, even if a developer's .env sets it.
      SMTP_HOST: '',
    },
  },
})
