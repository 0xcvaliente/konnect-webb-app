import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE 'reassign';
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE 'away_change';
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'teamMorningEmail';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'teamMorningEmail';
  CREATE TABLE "team_members" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"user_id" integer NOT NULL,
  	"away_from" timestamp(3) with time zone,
  	"away_until" timestamp(3) with time zone,
  	"covered_by_id" integer,
  	"morning_email_on" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "student_profiles" ADD COLUMN "taken_by_id" integer;
  ALTER TABLE "companies" ADD COLUMN "taken_by_id" integer;
  ALTER TABLE "projects" ADD COLUMN "owner_id" integer;
  ALTER TABLE "projects" ADD COLUMN "taken_by_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "team_members_id" integer;
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_covered_by_id_users_id_fk" FOREIGN KEY ("covered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");
  CREATE INDEX "team_members_covered_by_idx" ON "team_members" USING btree ("covered_by_id");
  CREATE INDEX "team_members_updated_at_idx" ON "team_members" USING btree ("updated_at");
  CREATE INDEX "team_members_created_at_idx" ON "team_members" USING btree ("created_at");
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_taken_by_id_users_id_fk" FOREIGN KEY ("taken_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "companies" ADD CONSTRAINT "companies_taken_by_id_users_id_fk" FOREIGN KEY ("taken_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "projects" ADD CONSTRAINT "projects_taken_by_id_users_id_fk" FOREIGN KEY ("taken_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_team_members_fk" FOREIGN KEY ("team_members_id") REFERENCES "public"."team_members"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "student_profiles_taken_by_idx" ON "student_profiles" USING btree ("taken_by_id");
  CREATE INDEX "companies_taken_by_idx" ON "companies" USING btree ("taken_by_id");
  CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id");
  CREATE INDEX "projects_taken_by_idx" ON "projects" USING btree ("taken_by_id");
  CREATE INDEX "payload_locked_documents_rels_team_members_id_idx" ON "payload_locked_documents_rels" USING btree ("team_members_id");`)
  // Projects follow their company's owner: existing projects start with it. Additive only, so
  // the version still running during a deploy keeps working (it ignores the new columns).
  await db.execute(sql`
  UPDATE "projects" AS p SET "owner_id" = c."team_owner_id"
  FROM "companies" AS c
  WHERE p."company_id" = c."id" AND p."owner_id" IS NULL AND c."team_owner_id" IS NOT NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "team_members" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "team_members" CASCADE;
  ALTER TABLE "student_profiles" DROP CONSTRAINT "student_profiles_taken_by_id_users_id_fk";
  
  ALTER TABLE "companies" DROP CONSTRAINT "companies_taken_by_id_users_id_fk";
  
  ALTER TABLE "projects" DROP CONSTRAINT "projects_owner_id_users_id_fk";
  
  ALTER TABLE "projects" DROP CONSTRAINT "projects_taken_by_id_users_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_team_members_fk";
  
  ALTER TABLE "activity_logs" ALTER COLUMN "action" SET DATA TYPE text;
  DROP TYPE "public"."enum_activity_logs_action";
  CREATE TYPE "public"."enum_activity_logs_action" AS ENUM('create', 'status_change', 'delete', 'sign_out_everywhere', 'sign_in_method_added', 'review_change', 'info_requested', 'info_answered');
  ALTER TABLE "activity_logs" ALTER COLUMN "action" SET DATA TYPE "public"."enum_activity_logs_action" USING "action"::"public"."enum_activity_logs_action";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "student_profiles_taken_by_idx";
  DROP INDEX "companies_taken_by_idx";
  DROP INDEX "projects_owner_idx";
  DROP INDEX "projects_taken_by_idx";
  DROP INDEX "payload_locked_documents_rels_team_members_id_idx";
  ALTER TABLE "student_profiles" DROP COLUMN "taken_by_id";
  ALTER TABLE "companies" DROP COLUMN "taken_by_id";
  ALTER TABLE "projects" DROP COLUMN "owner_id";
  ALTER TABLE "projects" DROP COLUMN "taken_by_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "team_members_id";`)
}
