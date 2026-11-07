import config from '@payload-config'
import { getPayload } from 'payload'

/**
 * Health check for Docker, Caddy, the deploy script and the uptime monitor: is this app container
 * up, and can it reach the database? `{"status":"ok"}` or `503 {"status":"unavailable"}`. Nothing
 * else: no versions, no error text, no timings, because anyone on the internet can call it.
 *
 * Public on purpose (no session needed). It runs one `SELECT 1`, so it is cheap enough to call
 * every few seconds. src/proxy.ts does not touch it (its matcher skips /api).
 */
export const dynamic = 'force-dynamic'

/** A database that does not answer within this time counts as down. */
const TIMEOUT_MS = 3000

const headers = { 'Cache-Control': 'no-store' }

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

async function databaseAnswers(): Promise<void> {
  const payload = await getPayload({ config })
  await payload.db.pool.query('SELECT 1')
}

export async function GET() {
  try {
    await withTimeout(databaseAnswers(), TIMEOUT_MS)
    return Response.json({ status: 'ok' }, { headers })
  } catch {
    // Deliberately no logging of the error: it can carry the connection string or host names.
    return Response.json({ status: 'unavailable' }, { status: 503, headers })
  }
}
