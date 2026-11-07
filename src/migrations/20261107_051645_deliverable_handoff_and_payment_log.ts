import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Kanban cards "Deliverable submission and handoff" and "Manual payment log in admin": the
// hand-in statuses after release (returned, fix requested, accepted) with their dates and notes,
// the hourly job that accepts released work after 7 days, and the payment log's invoice number
// and team notes. Additive only: older code keeps working against this schema.

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_deliverables_accepted_by" AS ENUM('company', 'team', 'auto');
  ALTER TYPE "public"."enum_deliverables_status" ADD VALUE 'returned' BEFORE 'released';
  ALTER TYPE "public"."enum_deliverables_status" ADD VALUE 'fix_requested';
  ALTER TYPE "public"."enum_deliverables_status" ADD VALUE 'accepted';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'acceptDueDeliverables';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'acceptDueDeliverables';
  ALTER TABLE "deliverables" ADD COLUMN "released_at" timestamp(3) with time zone;
  ALTER TABLE "deliverables" ADD COLUMN "return_note" varchar;
  ALTER TABLE "deliverables" ADD COLUMN "returned_at" timestamp(3) with time zone;
  ALTER TABLE "deliverables" ADD COLUMN "fix_note" varchar;
  ALTER TABLE "deliverables" ADD COLUMN "fix_requested_at" timestamp(3) with time zone;
  ALTER TABLE "deliverables" ADD COLUMN "accepted_at" timestamp(3) with time zone;
  ALTER TABLE "deliverables" ADD COLUMN "accepted_by" "enum_deliverables_accepted_by";
  ALTER TABLE "payments" ADD COLUMN "invoice_number" varchar;
  ALTER TABLE "payments" ADD COLUMN "notes" varchar;
  CREATE INDEX "deliverables_released_at_idx" ON "deliverables" USING btree ("released_at");`)
  // Deliverables released before this change: the 7 days for fixes count from when they were last
  // changed (the release), as close as the stored data allows.
  await db.execute(sql`
   UPDATE "deliverables" SET "released_at" = "updated_at"
   WHERE "status" = 'released' AND "released_at" IS NULL;`)
  // One payment log row per paid match: the rows the Matches hook now makes, for matches made
  // before it existed, with the project's fixed price.
  await db.execute(sql`
   INSERT INTO "payments" ("match_id", "project_fee", "updated_at", "created_at")
   SELECT m."id", p."fee", now(), now()
   FROM "matches" AS m JOIN "projects" AS p ON p."id" = m."project_id"
   WHERE p."paid_or_unpaid" = 'paid'
     AND NOT EXISTS (SELECT 1 FROM "payments" AS x WHERE x."match_id" = m."id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "deliverables" ALTER COLUMN "status" SET DATA TYPE text;
  ALTER TABLE "deliverables" ALTER COLUMN "status" SET DEFAULT 'submitted'::text;
  UPDATE "deliverables" SET "status" = 'released' WHERE "status" IN ('fix_requested', 'accepted');
  UPDATE "deliverables" SET "status" = 'submitted' WHERE "status" = 'returned';
  DELETE FROM "payload_jobs_log" WHERE "task_slug" = 'acceptDueDeliverables';
  DELETE FROM "payload_jobs" WHERE "task_slug" = 'acceptDueDeliverables';
  DROP TYPE "public"."enum_deliverables_status";
  CREATE TYPE "public"."enum_deliverables_status" AS ENUM('submitted', 'released');
  ALTER TABLE "deliverables" ALTER COLUMN "status" SET DEFAULT 'submitted'::"public"."enum_deliverables_status";
  ALTER TABLE "deliverables" ALTER COLUMN "status" SET DATA TYPE "public"."enum_deliverables_status" USING "status"::"public"."enum_deliverables_status";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "deliverables_released_at_idx";
  ALTER TABLE "deliverables" DROP COLUMN "released_at";
  ALTER TABLE "deliverables" DROP COLUMN "return_note";
  ALTER TABLE "deliverables" DROP COLUMN "returned_at";
  ALTER TABLE "deliverables" DROP COLUMN "fix_note";
  ALTER TABLE "deliverables" DROP COLUMN "fix_requested_at";
  ALTER TABLE "deliverables" DROP COLUMN "accepted_at";
  ALTER TABLE "deliverables" DROP COLUMN "accepted_by";
  ALTER TABLE "payments" DROP COLUMN "invoice_number";
  ALTER TABLE "payments" DROP COLUMN "notes";
  DROP TYPE "public"."enum_deliverables_accepted_by";`)
}
