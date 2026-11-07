import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Kanban cards "Problem reports: more time, match again, close without delivery" and "Projects
// without a match: reopen, ask for changes, close": the students' problem reports, a match's end
// time and its moved due dates, the application status `match_ended`, and why and when a project
// was closed or reopened. Additive: older code keeps working against this schema.
//
// A project may now have several matches over time, but only one that is not ended. Payload's
// `indexes` cannot express a partial index, so it is made here by hand: the new partial unique
// index is created before the old unique index on matches.project_id is dropped, so there is no
// moment without the rule.

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_projects_close_outcome" AS ENUM('delivered', 'no_delivery', 'no_match');
  CREATE TYPE "public"."enum_projects_reopen_reason" AS ENUM('match_ended', 'no_match');
  CREATE TYPE "public"."enum_problem_reports_kind" AS ENUM('more_time', 'cannot_finish');
  CREATE TYPE "public"."enum_problem_reports_status" AS ENUM('open', 'resolved');
  CREATE TYPE "public"."enum_problem_reports_resolution" AS ENUM('date_moved', 'match_ended', 'closed', 'no_change');
  ALTER TYPE "public"."enum_applications_status" ADD VALUE 'match_ended';
  CREATE TABLE "matches_due_date_history" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"from" timestamp(3) with time zone,
  	"to" timestamp(3) with time zone,
  	"changed_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "problem_reports" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"match_id" integer NOT NULL,
  	"project_id" integer,
  	"student_id" integer,
  	"kind" "enum_problem_reports_kind" NOT NULL,
  	"note" varchar NOT NULL,
  	"status" "enum_problem_reports_status" DEFAULT 'open' NOT NULL,
  	"resolution" "enum_problem_reports_resolution",
  	"resolved_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "projects" ADD COLUMN "close_reason" varchar;
  ALTER TABLE "projects" ADD COLUMN "close_outcome" "enum_projects_close_outcome";
  ALTER TABLE "projects" ADD COLUMN "closed_at" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "reopened_at" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "reopen_reason" "enum_projects_reopen_reason";
  ALTER TABLE "applications" ADD COLUMN "ended_at" timestamp(3) with time zone;
  ALTER TABLE "matches" ADD COLUMN "ended_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "problem_reports_id" integer;
  ALTER TABLE "matches_due_date_history" ADD CONSTRAINT "matches_due_date_history_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "matches_due_date_history_order_idx" ON "matches_due_date_history" USING btree ("_order");
  CREATE INDEX "matches_due_date_history_parent_id_idx" ON "matches_due_date_history" USING btree ("_parent_id");
  CREATE INDEX "problem_reports_match_idx" ON "problem_reports" USING btree ("match_id");
  CREATE INDEX "problem_reports_project_idx" ON "problem_reports" USING btree ("project_id");
  CREATE INDEX "problem_reports_student_idx" ON "problem_reports" USING btree ("student_id");
  CREATE INDEX "problem_reports_status_idx" ON "problem_reports" USING btree ("status");
  CREATE INDEX "problem_reports_updated_at_idx" ON "problem_reports" USING btree ("updated_at");
  CREATE INDEX "problem_reports_created_at_idx" ON "problem_reports" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_problem_reports_fk" FOREIGN KEY ("problem_reports_id") REFERENCES "public"."problem_reports"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "matches_ended_at_idx" ON "matches" USING btree ("ended_at");
  CREATE UNIQUE INDEX "matches_one_active_per_project_idx" ON "matches" USING btree ("project_id") WHERE "ended_at" IS NULL;
  DROP INDEX "project_idx";
  CREATE INDEX "payload_locked_documents_rels_problem_reports_id_idx" ON "payload_locked_documents_rels" USING btree ("problem_reports_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "matches_due_date_history" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "problem_reports" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "matches_due_date_history" CASCADE;
  DROP TABLE "problem_reports" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_problem_reports_fk";
  
  ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE text;
  ALTER TABLE "applications" ALTER COLUMN "status" SET DEFAULT 'applied'::text;
  DROP TYPE "public"."enum_applications_status";
  CREATE TYPE "public"."enum_applications_status" AS ENUM('applied', 'shortlisted', 'selected', 'not_selected', 'withdrawn');
  ALTER TABLE "applications" ALTER COLUMN "status" SET DEFAULT 'applied'::"public"."enum_applications_status";
  ALTER TABLE "applications" ALTER COLUMN "status" SET DATA TYPE "public"."enum_applications_status" USING "status"::"public"."enum_applications_status";
  DROP INDEX "matches_one_active_per_project_idx";
  DROP INDEX "matches_ended_at_idx";
  DROP INDEX "payload_locked_documents_rels_problem_reports_id_idx";
  CREATE UNIQUE INDEX "project_idx" ON "matches" USING btree ("project_id");
  ALTER TABLE "projects" DROP COLUMN "close_reason";
  ALTER TABLE "projects" DROP COLUMN "close_outcome";
  ALTER TABLE "projects" DROP COLUMN "closed_at";
  ALTER TABLE "projects" DROP COLUMN "reopened_at";
  ALTER TABLE "projects" DROP COLUMN "reopen_reason";
  ALTER TABLE "applications" DROP COLUMN "ended_at";
  ALTER TABLE "matches" DROP COLUMN "ended_at";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "problem_reports_id";
  DROP TYPE "public"."enum_projects_close_outcome";
  DROP TYPE "public"."enum_projects_reopen_reason";
  DROP TYPE "public"."enum_problem_reports_kind";
  DROP TYPE "public"."enum_problem_reports_status";
  DROP TYPE "public"."enum_problem_reports_resolution";`)
}
