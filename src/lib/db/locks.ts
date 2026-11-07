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
 * profile; for the work on a match: match, then deliverable; a payment row on its own. A lock
 * taken twice in one transaction is free.
 *
 * `share` (`FOR SHARE`) is for a write that only depends on a row staying as it is: a student
 * applying locks the project in share mode, so applies to one project do not wait for each other,
 * but an apply and a selection on that project (`FOR UPDATE`) run one after the other.
 */

const TABLES = {
  projects: 'projects',
  applications: 'applications',
  'student-profiles': 'student_profiles',
  matches: 'matches',
  deliverables: 'deliverables',
  payments: 'payments',
} as const

export type LockableCollection = keyof typeof TABLES

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }

export type LockMode = 'update' | 'share'

/**
 * Lock one row until `req`'s transaction ends. Throws when there is no transaction: without one
 * the lock would end at once and protect nothing (Payload opens one for every create, update and
 * delete, and passes it to nested calls that get `req`).
 */
export async function lockRow(
  req: PayloadRequest,
  collection: LockableCollection,
  id: number,
  mode: LockMode = 'update',
): Promise<void> {
  const transactionID = req.transactionID ? await req.transactionID : undefined
  const tx = transactionID === undefined ? undefined : req.payload.db.sessions?.[transactionID]
  if (!tx) throw new Error('lockRow needs an open transaction')
  if (!Number.isInteger(id) || id < 1) return
  const table = sql.identifier(TABLES[collection])
  await (tx.db as Executor).execute(
    mode === 'share'
      ? sql`SELECT 1 FROM ${table} WHERE "id" = ${id} FOR SHARE`
      : sql`SELECT 1 FROM ${table} WHERE "id" = ${id} FOR UPDATE`,
  )
}
