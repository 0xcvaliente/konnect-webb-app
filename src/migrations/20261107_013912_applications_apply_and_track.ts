import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "applications" ADD COLUMN "profile_waiting" boolean DEFAULT false;
  ALTER TABLE "applications" ADD COLUMN "project_title" varchar;
  ALTER TABLE "applications" ADD COLUMN "company_name" varchar;
  ALTER TABLE "applications" ADD COLUMN "closes_on" timestamp(3) with time zone;
  ALTER TABLE "applications" ADD COLUMN "shortlisted_at" timestamp(3) with time zone;
  ALTER TABLE "applications" ADD COLUMN "decided_at" timestamp(3) with time zone;
  ALTER TABLE "applications" ADD COLUMN "withdrawn_at" timestamp(3) with time zone;`)
  // Applications made before this change: copy what they were made for from the project, so
  // My applications names the project after it is matched or closed.
  await db.execute(sql`
   UPDATE "applications" AS a
   SET "project_title" = p."title", "company_name" = p."company_name", "closes_on" = p."deadline"
   FROM "projects" AS p
   WHERE p."id" = a."project_id" AND a."project_title" IS NULL;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "applications" DROP COLUMN "profile_waiting";
  ALTER TABLE "applications" DROP COLUMN "project_title";
  ALTER TABLE "applications" DROP COLUMN "company_name";
  ALTER TABLE "applications" DROP COLUMN "closes_on";
  ALTER TABLE "applications" DROP COLUMN "shortlisted_at";
  ALTER TABLE "applications" DROP COLUMN "decided_at";
  ALTER TABLE "applications" DROP COLUMN "withdrawn_at";`)
}
