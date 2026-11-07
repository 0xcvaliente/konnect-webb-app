import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_payments_student_payout" AS ENUM('waiting_company', 'next_pay_run', 'paid');
  CREATE TYPE "public"."enum_questions_kind" AS ENUM('ask', 'relay');
  CREATE TYPE "public"."enum_questions_side" AS ENUM('student', 'company');
  CREATE TYPE "public"."enum_questions_status" AS ENUM('open', 'answered');
  CREATE TYPE "public"."enum_feedback_side" AS ENUM('student', 'company');
  ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'questionReminder';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'questionReminder';
  CREATE TABLE "questions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"kind" "enum_questions_kind" DEFAULT 'ask' NOT NULL,
  	"project_id" integer,
  	"application_id" integer,
  	"side" "enum_questions_side",
  	"asked_by_id" integer,
  	"recipient_id" integer,
  	"relay_of_id" integer,
  	"body" varchar NOT NULL,
  	"status" "enum_questions_status" DEFAULT 'open' NOT NULL,
  	"answer" varchar,
  	"answered_by_id" integer,
  	"answered_by_name" varchar,
  	"answered_at" timestamp(3) with time zone,
  	"reminder_sent_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "saved_answers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"body" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "feedback" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"project_id" integer NOT NULL,
  	"match_id" integer,
  	"side" "enum_feedback_side",
  	"author_id" integer,
  	"rating" numeric NOT NULL,
  	"went_well" varchar,
  	"could_be_better" varchar,
  	"again" boolean DEFAULT false,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "companies" ADD COLUMN "invoice_email" varchar;
  ALTER TABLE "companies" ADD COLUMN "invoice_reference" varchar;
  ALTER TABLE "companies" ADD COLUMN "ehf_invoice" boolean DEFAULT false;
  ALTER TABLE "payments" ADD COLUMN "student_payout" "enum_payments_student_payout" DEFAULT 'waiting_company';
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "questions_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "saved_answers_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "feedback_id" integer;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_asked_by_id_users_id_fk" FOREIGN KEY ("asked_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_relay_of_id_questions_id_fk" FOREIGN KEY ("relay_of_id") REFERENCES "public"."questions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_id_users_id_fk" FOREIGN KEY ("answered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "feedback" ADD CONSTRAINT "feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "questions_kind_idx" ON "questions" USING btree ("kind");
  CREATE INDEX "questions_project_idx" ON "questions" USING btree ("project_id");
  CREATE INDEX "questions_application_idx" ON "questions" USING btree ("application_id");
  CREATE INDEX "questions_asked_by_idx" ON "questions" USING btree ("asked_by_id");
  CREATE INDEX "questions_recipient_idx" ON "questions" USING btree ("recipient_id");
  CREATE INDEX "questions_relay_of_idx" ON "questions" USING btree ("relay_of_id");
  CREATE INDEX "questions_status_idx" ON "questions" USING btree ("status");
  CREATE INDEX "questions_answered_by_idx" ON "questions" USING btree ("answered_by_id");
  CREATE INDEX "questions_answered_at_idx" ON "questions" USING btree ("answered_at");
  CREATE INDEX "questions_updated_at_idx" ON "questions" USING btree ("updated_at");
  CREATE INDEX "questions_created_at_idx" ON "questions" USING btree ("created_at");
  CREATE INDEX "saved_answers_updated_at_idx" ON "saved_answers" USING btree ("updated_at");
  CREATE INDEX "saved_answers_created_at_idx" ON "saved_answers" USING btree ("created_at");
  CREATE INDEX "feedback_project_idx" ON "feedback" USING btree ("project_id");
  CREATE INDEX "feedback_match_idx" ON "feedback" USING btree ("match_id");
  CREATE INDEX "feedback_author_idx" ON "feedback" USING btree ("author_id");
  CREATE INDEX "feedback_updated_at_idx" ON "feedback" USING btree ("updated_at");
  CREATE INDEX "feedback_created_at_idx" ON "feedback" USING btree ("created_at");
  CREATE UNIQUE INDEX "project_author_idx" ON "feedback" USING btree ("project_id","author_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_questions_fk" FOREIGN KEY ("questions_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_saved_answers_fk" FOREIGN KEY ("saved_answers_id") REFERENCES "public"."saved_answers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_feedback_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_questions_id_idx" ON "payload_locked_documents_rels" USING btree ("questions_id");
  CREATE INDEX "payload_locked_documents_rels_saved_answers_id_idx" ON "payload_locked_documents_rels" USING btree ("saved_answers_id");
  CREATE INDEX "payload_locked_documents_rels_feedback_id_idx" ON "payload_locked_documents_rels" USING btree ("feedback_id");`)
  // Rows saved before the student's status existed: work it out from their dates, the way the
  // Payments hook does on every save (lib/payments/fields.ts, studentPayoutStatus).
  await db.execute(sql`
   UPDATE "payments" SET "student_payout" = CASE
     WHEN "student_paid_at" IS NOT NULL THEN 'paid'::"enum_payments_student_payout"
     WHEN "invoice_paid_at" IS NOT NULL THEN 'next_pay_run'::"enum_payments_student_payout"
     ELSE 'waiting_company'::"enum_payments_student_payout"
   END;`)
  // Rows made before the student's pay was copied from the project: copy it now, where the team
  // set none on the row (the Payments hook does this when it makes a row).
  await db.execute(sql`
   UPDATE "payments" AS p SET "student_pay" = pr."student_pay"
   FROM "matches" AS m, "projects" AS pr
   WHERE m."id" = p."match_id" AND pr."id" = m."project_id"
     AND p."student_pay" IS NULL AND pr."student_pay" IS NOT NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "questions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "saved_answers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "feedback" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "questions" CASCADE;
  DROP TABLE "saved_answers" CASCADE;
  DROP TABLE "feedback" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_questions_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_saved_answers_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_feedback_fk";
  
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables', 'teamMorningEmail', 'decisionReminder');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'removeUnusedFiles', 'generateAgreement', 'sendAgreementEmail', 'acceptDueDeliverables', 'teamMorningEmail', 'decisionReminder');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  DROP INDEX "payload_locked_documents_rels_questions_id_idx";
  DROP INDEX "payload_locked_documents_rels_saved_answers_id_idx";
  DROP INDEX "payload_locked_documents_rels_feedback_id_idx";
  ALTER TABLE "companies" DROP COLUMN "invoice_email";
  ALTER TABLE "companies" DROP COLUMN "invoice_reference";
  ALTER TABLE "companies" DROP COLUMN "ehf_invoice";
  ALTER TABLE "payments" DROP COLUMN "student_payout";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "questions_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "saved_answers_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "feedback_id";
  DROP TYPE "public"."enum_payments_student_payout";
  DROP TYPE "public"."enum_questions_kind";
  DROP TYPE "public"."enum_questions_side";
  DROP TYPE "public"."enum_questions_status";
  DROP TYPE "public"."enum_feedback_side";`)
}
