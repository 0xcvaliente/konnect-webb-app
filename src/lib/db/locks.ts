import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

/**
 * Row locks for decisions that read, then write, several documents (selecting a student: the
 * project, the application and the student's other projects). Payload takes no row locks, so two
 * team members deciding at the same moment could both pass the same check. `SELECT ... FOR UPDATE`
 * makes the second one wait until the first commits or rolls back; it then reads the first one's
 * result (PostgreSQL's default READ COMMITTED takes a fresh snapshot for each statement).
 *
 * Always lock in the same order to avoid deadlocks: project, then application, then student
 * profile. A lock taken twice in one transaction is free.
 */

const TABLES = {
  projects: 'projects',
  applications: 'applications',
  'student-profiles': 'student_profiles',
} as const

export type LockableCollection = keyof typeof TABLES

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }

/**
 * Lock one row until `req`'s transaction ends. Throws when there is no transaction: without one
 * the lock would end at once and protect nothing (Payload opens one for every create, update and
 * delete, and passes it to nested calls that get `req`).
 */
export async function lockRow(
  req: PayloadRequest,
  collection: LockableCollection,
  id: number,
): Promise<void> {
  const transactionID = req.transactionID ? await req.transactionID : undefined
  const tx = transactionID === undefined ? undefined : req.payload.db.sessions?.[transactionID]
  if (!tx) throw new Error('lockRow needs an open transaction')
  if (!Number.isInteger(id) || id < 1) return
  await (tx.db as Executor).execute(
    sql`SELECT 1 FROM ${sql.identifier(TABLES[collection])} WHERE "id" = ${id} FOR UPDATE`,
  )
}
