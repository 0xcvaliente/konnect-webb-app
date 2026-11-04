import { loadEnvFile } from 'node:process'

/**
 * The test database URL: the dev DATABASE_URL with the database name replaced by `<name>_test`.
 * Tests never touch the dev database. Everything here refuses to run against a name that does
 * not end in `_test`.
 */
export function baseDatabaseUrl(): string {
  try {
    loadEnvFile('.env')
  } catch {
    // No .env (for example in CI). DATABASE_URL may come from the environment.
  }
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.')
  return url
}

export function testDatabaseUrl(): string {
  const url = new URL(baseDatabaseUrl())
  const name = url.pathname.replace(/^\//, '').replace(/_test$/, '')
  url.pathname = `/${name}_test`
  return url.toString()
}

export function testDatabaseName(): string {
  const name = new URL(testDatabaseUrl()).pathname.replace(/^\//, '')
  if (!name.endsWith('_test')) throw new Error(`Refusing to use database "${name}" for tests`)
  return name
}
