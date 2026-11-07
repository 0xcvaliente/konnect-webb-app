import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * The company's project form (Kanban card "Project submission form (company)").
 *
 * Adds the structured answers the form asks for (workload in hours, timeframe in weeks, earliest
 * start, where the work is done, paid or unpaid and what an unpaid student gets) and Konnected's
 * latest note to the company. `description` may be empty on a draft: the form saves drafts as the
 * company types, and sending for review checks that everything is there.
 *
 * Only adds columns and relaxes one NOT NULL, so the previous release keeps working on this
 * schema (it always writes a description). The old free-text `workload` and `duration` columns
 * stay; a later migration removes them.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_projects_work_mode" AS ENUM('remote', 'on_site', 'hybrid');
  CREATE TYPE "public"."enum_projects_paid_or_unpaid" AS ENUM('paid', 'unpaid');
  ALTER TABLE "projects" ALTER COLUMN "description" DROP NOT NULL;
  ALTER TABLE "projects" ADD COLUMN "workload_hours" numeric;
  ALTER TABLE "projects" ADD COLUMN "duration_weeks" numeric;
  ALTER TABLE "projects" ADD COLUMN "start_date" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "work_mode" "enum_projects_work_mode";
  ALTER TABLE "projects" ADD COLUMN "paid_or_unpaid" "enum_projects_paid_or_unpaid";
  ALTER TABLE "projects" ADD COLUMN "unpaid_benefit" varchar;
  ALTER TABLE "projects" ADD COLUMN "note_to_company" varchar;
  ALTER TABLE "projects" ADD COLUMN "note_to_company_at" timestamp(3) with time zone;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   UPDATE "projects" SET "description" = '' WHERE "description" IS NULL;
  ALTER TABLE "projects" ALTER COLUMN "description" SET NOT NULL;
  ALTER TABLE "projects" DROP COLUMN "workload_hours";
  ALTER TABLE "projects" DROP COLUMN "duration_weeks";
  ALTER TABLE "projects" DROP COLUMN "start_date";
  ALTER TABLE "projects" DROP COLUMN "work_mode";
  ALTER TABLE "projects" DROP COLUMN "paid_or_unpaid";
  ALTER TABLE "projects" DROP COLUMN "unpaid_benefit";
  ALTER TABLE "projects" DROP COLUMN "note_to_company";
  ALTER TABLE "projects" DROP COLUMN "note_to_company_at";
  DROP TYPE "public"."enum_projects_work_mode";
  DROP TYPE "public"."enum_projects_paid_or_unpaid";`)
}
