import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'decisionReminder';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'decisionReminder';
  CREATE TABLE "matches_kickoff_check_ins" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"day" timestamp(3) with time zone NOT NULL
  );
  
  ALTER TABLE "projects" ADD COLUMN "decision_by" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "decision_reminder_for" timestamp(3) with time zone;
  ALTER TABLE "matches" ADD COLUMN "kickoff_scope" varchar;
  ALTER TABLE "matches" ADD COLUMN "kickoff_delivery" varchar;
  ALTER TABLE "matches" ADD COLUMN "kickoff_contact_id" integer;
  ALTER TABLE "matches" ADD COLUMN "kickoff_contact_name" varchar;
  ALTER TABLE "matches" ADD COLUMN "kickoff_recorded_at" timestamp(3) with time zone;
  ALTER TABLE "matches_kickoff_check_ins" ADD CONSTRAINT "matches_kickoff_check_ins_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "matches_kickoff_check_ins_order_idx" ON "matches_kickoff_check_ins" USING btree ("_order");
  CREATE INDEX "matches_kickoff_check_ins_parent_id_idx" ON "matches_kickoff_check_ins" USING btree ("_parent_id");
  ALTER TABLE "matches" ADD CONSTRAINT "matches_kickoff_contact_id_users_id_fk" FOREIGN KEY ("kickoff_contact_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "projects_decision_by_idx" ON "projects" USING btree ("decision_by");
  CREATE INDEX "matches_kickoff_kickoff_contact_idx" ON "matches" USING btree ("kickoff_contact_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "matches_kickoff_check_ins" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "matches_kickoff_check_ins" CASCADE;
  ALTER TABLE "matches" DROP CONSTRAINT "matches_kickoff_contact_id_users_id_fk";
  
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables', 'teamMorningEmail');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables', 'teamMorningEmail');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "projects_decision_by_idx";
  DROP INDEX "matches_kickoff_kickoff_contact_idx";
  ALTER TABLE "projects" DROP COLUMN "decision_by";
  ALTER TABLE "projects" DROP COLUMN "decision_reminder_for";
  ALTER TABLE "matches" DROP COLUMN "kickoff_scope";
  ALTER TABLE "matches" DROP COLUMN "kickoff_delivery";
  ALTER TABLE "matches" DROP COLUMN "kickoff_contact_id";
  ALTER TABLE "matches" DROP COLUMN "kickoff_contact_name";
  ALTER TABLE "matches" DROP COLUMN "kickoff_recorded_at";`)
}
