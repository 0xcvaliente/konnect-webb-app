import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// New accounts start as `pending` (no access) instead of `student`. Separate from the migration
// that adds the value, because Postgres refuses to use a new enum value in the same transaction.
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'pending';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'student';`)
}
