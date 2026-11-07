import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * The team's approval queue (Kanban card "Admin approval queue for companies and projects", plus
 * profile review).
 *
 * - Student profiles: the team can ask for changes (`changes_requested`, with a note the student
 *   reads), the review clock (`review_requested_at`), and what changed since the last review
 *   (`changed_since_review_at` and a copy of the reviewed fields in `reviewed_snapshot`).
 * - Companies: Konnected's note, "more information asked", the review clock, and the one
 *   correction a rejected company may send (`resent_at`).
 * - Projects: when the project was sent for review (`submitted_at`).
 * - Activity log: rows for review decisions that are not status changes.
 *
 * Only adds enum values, columns and an index, and fills the new clocks from data that is already
 * there, so the previous release keeps working on this schema. `down` keeps the added enum values
 * (Postgres cannot drop one, and recreating the types would have to delete activity rows); it
 * moves profiles waiting for changes back to `waiting` and drops the new columns.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_student_profiles_review_status" ADD VALUE IF NOT EXISTS 'changes_requested' BEFORE 'reviewed';
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE IF NOT EXISTS 'review_change';
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE IF NOT EXISTS 'info_requested';
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE IF NOT EXISTS 'info_answered';
  ALTER TABLE "student_profiles" ADD COLUMN "review_note" varchar;
  ALTER TABLE "student_profiles" ADD COLUMN "review_note_at" timestamp(3) with time zone;
  ALTER TABLE "student_profiles" ADD COLUMN "review_requested_at" timestamp(3) with time zone;
  ALTER TABLE "student_profiles" ADD COLUMN "changed_since_review_at" timestamp(3) with time zone;
  ALTER TABLE "student_profiles" ADD COLUMN "reviewed_snapshot" jsonb;
  ALTER TABLE "companies" ADD COLUMN "note_to_company" varchar;
  ALTER TABLE "companies" ADD COLUMN "note_to_company_at" timestamp(3) with time zone;
  ALTER TABLE "companies" ADD COLUMN "info_requested_at" timestamp(3) with time zone;
  ALTER TABLE "companies" ADD COLUMN "review_requested_at" timestamp(3) with time zone;
  ALTER TABLE "companies" ADD COLUMN "resent_at" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "submitted_at" timestamp(3) with time zone;
  CREATE INDEX "student_profiles_changed_since_review_at_idx" ON "student_profiles" USING btree ("changed_since_review_at");

  UPDATE "student_profiles" SET "review_requested_at" = "created_at" WHERE "review_requested_at" IS NULL;
  UPDATE "companies" SET "review_requested_at" = "created_at" WHERE "review_requested_at" IS NULL;
  UPDATE "projects" AS p SET "submitted_at" = COALESCE(
    (SELECT max(a."created_at") FROM "activity_logs" AS a
      WHERE a."target_collection" = 'projects' AND a."target_id" = p."id"::text
        AND a."to_status" = 'submitted'),
    p."updated_at")
  WHERE p."status" <> 'draft' AND p."submitted_at" IS NULL;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   UPDATE "student_profiles" SET "review_status" = 'waiting' WHERE "review_status"::text = 'changes_requested';
  DROP INDEX IF EXISTS "student_profiles_changed_since_review_at_idx";
  ALTER TABLE "student_profiles" DROP COLUMN "review_note";
  ALTER TABLE "student_profiles" DROP COLUMN "review_note_at";
  ALTER TABLE "student_profiles" DROP COLUMN "review_requested_at";
  ALTER TABLE "student_profiles" DROP COLUMN "changed_since_review_at";
  ALTER TABLE "student_profiles" DROP COLUMN "reviewed_snapshot";
  ALTER TABLE "companies" DROP COLUMN "note_to_company";
  ALTER TABLE "companies" DROP COLUMN "note_to_company_at";
  ALTER TABLE "companies" DROP COLUMN "info_requested_at";
  ALTER TABLE "companies" DROP COLUMN "review_requested_at";
  ALTER TABLE "companies" DROP COLUMN "resent_at";
  ALTER TABLE "projects" DROP COLUMN "submitted_at";`)
}
