import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * The student project list (Kanban card "Student project list, search, filters and detail page").
 *
 * - Projects: what the student is paid (`student_pay`, optional, written by the team, never read
 *   by a company) and when the project was published (`published_at`, set by the server; the list
 *   sorts on it, newest first), with an index for that sort.
 *
 * Only adds nullable columns and an index, and fills `published_at` for projects that are already
 * published (or further on) from their last change, the best date there is. The previous release
 * keeps working on this schema. `down` drops the index and the columns.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "projects" ADD COLUMN "student_pay" numeric;
  ALTER TABLE "projects" ADD COLUMN "published_at" timestamp(3) with time zone;
  CREATE INDEX "projects_published_at_idx" ON "projects" USING btree ("published_at");
  UPDATE "projects" SET "published_at" = "updated_at"
    WHERE "published_at" IS NULL
      AND "status" IN ('published', 'matched', 'in_progress', 'delivered', 'closed');`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX IF EXISTS "projects_published_at_idx";
  ALTER TABLE "projects" DROP COLUMN IF EXISTS "student_pay";
  ALTER TABLE "projects" DROP COLUMN IF EXISTS "published_at";`)
}
