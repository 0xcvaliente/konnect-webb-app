import { execFileSync } from 'node:child_process'

import pg from 'pg'

import { baseDatabaseUrl, testDatabaseName, testDatabaseUrl } from './env'

/**
 * Create a fresh, empty test database and apply the committed migrations to it with the Payload
 * CLI. This also proves the migrations run cleanly on an empty PostgreSQL database.
 */
export default async function setup() {
  const name = testDatabaseName()
  const admin = new pg.Client({ connectionString: baseDatabaseUrl() })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin.query(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end()
  }

  execFileSync('pnpm', ['payload', 'migrate'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      PAYLOAD_SECRET: 'test-only-secret-not-used-anywhere-else',
    },
  })
}
