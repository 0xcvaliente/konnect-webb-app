import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_student_profiles_review_status" AS ENUM('waiting', 'reviewed');
  ALTER TABLE "student_profiles" ADD COLUMN "privacy_share_school" boolean DEFAULT false;
  ALTER TABLE "student_profiles" ADD COLUMN "privacy_share_contact_email" boolean DEFAULT false;
  ALTER TABLE "student_profiles" ADD COLUMN "privacy_share_phone" boolean DEFAULT false;
  ALTER TABLE "student_profiles" ADD COLUMN "review_status" "enum_student_profiles_review_status" DEFAULT 'waiting';
  ALTER TABLE "student_profiles" ADD COLUMN "reviewed_at" timestamp(3) with time zone;
  ALTER TABLE "matches" ADD COLUMN "shared_info_school" varchar;
  ALTER TABLE "matches" ADD COLUMN "shared_info_programme" varchar;
  ALTER TABLE "matches" ADD COLUMN "shared_info_year" numeric;
  ALTER TABLE "matches" ADD COLUMN "shared_info_contact_email" varchar;
  ALTER TABLE "matches" ADD COLUMN "shared_info_phone" varchar;
  CREATE INDEX "student_profiles_review_status_idx" ON "student_profiles" USING btree ("review_status");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "student_profiles_review_status_idx";
  ALTER TABLE "student_profiles" DROP COLUMN "privacy_share_school";
  ALTER TABLE "student_profiles" DROP COLUMN "privacy_share_contact_email";
  ALTER TABLE "student_profiles" DROP COLUMN "privacy_share_phone";
  ALTER TABLE "student_profiles" DROP COLUMN "review_status";
  ALTER TABLE "student_profiles" DROP COLUMN "reviewed_at";
  ALTER TABLE "matches" DROP COLUMN "shared_info_school";
  ALTER TABLE "matches" DROP COLUMN "shared_info_programme";
  ALTER TABLE "matches" DROP COLUMN "shared_info_year";
  ALTER TABLE "matches" DROP COLUMN "shared_info_contact_email";
  ALTER TABLE "matches" DROP COLUMN "shared_info_phone";
  DROP TYPE "public"."enum_student_profiles_review_status";`)
}
