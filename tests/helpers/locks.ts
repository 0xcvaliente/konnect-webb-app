import pg from 'pg'
import {
  commitTransaction,
  createLocalReq,
  initTransaction,
  killTransaction,
  type Payload,
  type PayloadRequest,
} from 'payload'

import type { User } from '@/payload-types'

import { asUser } from './world'

/** Wait until some database session is waiting for a row lock (the second of two decisions). */
export async function waitForLockWait(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  try {
    for (let i = 0; i < 200; i++) {
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      )
      if (rows.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('The second decision never waited for the first')
  } finally {
    await pool.end()
  }
}

/**
 * Two decisions at the same moment, in a fixed order: `first` runs as `user` in its own
 * transaction and keeps its row locks; `second` starts while they are held. Once `second` waits on
 * a lock, `first` commits. Returns how `second` ended.
 */
export async function whileHeld<T>(
  payload: Payload,
  user: User,
  first: (req: PayloadRequest) => Promise<unknown>,
  second: () => Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const req = await createLocalReq({ user: asUser(user) as never }, payload)
  await initTransaction(req)
  let pending: Promise<T> | undefined
  try {
    await first(req)
    pending = second()
    pending.catch(() => {})
    await waitForLockWait()
    await commitTransaction(req)
  } catch (error) {
    await killTransaction(req)
    throw error
  }
  const [outcome] = await Promise.allSettled([pending])
  return outcome
}
