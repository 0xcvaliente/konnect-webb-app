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
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: testDatabaseUrl(),
      PAYLOAD_SECRET: 'test-only-secret-not-used-anywhere-else',
      ADMIN_EMAILS: 'admin@konnected.test',
    },
  },
})
