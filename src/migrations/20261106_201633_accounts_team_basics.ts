import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Accounts and the team workspace: the person's name, pausing an account, the sign-in method
 * bookkeeping (password set, last sign-in, the "new way to sign in" notice), and two new activity
 * log actions with the changed field and the team's note. Only adds columns, types and indexes,
 * so the previous release keeps working against the new schema.
 */
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_account_status" AS ENUM('active', 'paused');
  CREATE TYPE "public"."enum_users_method_added_notice" AS ENUM('google', 'password');
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE 'sign_out_everywhere';
  ALTER TYPE "public"."enum_activity_logs_action" ADD VALUE 'sign_in_method_added';
  ALTER TABLE "users" ADD COLUMN "name" varchar;
  ALTER TABLE "users" ADD COLUMN "account_status" "enum_users_account_status" DEFAULT 'active';
  ALTER TABLE "users" ADD COLUMN "password_set_at" timestamp(3) with time zone;
  ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp(3) with time zone;
  ALTER TABLE "users" ADD COLUMN "method_added_notice" "enum_users_method_added_notice";
  ALTER TABLE "activity_logs" ADD COLUMN "field" varchar;
  ALTER TABLE "activity_logs" ADD COLUMN "note" varchar;
  CREATE INDEX "users_account_status_idx" ON "users" USING btree ("account_status");
  CREATE INDEX "activity_logs_target_id_idx" ON "activity_logs" USING btree ("target_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Rows with the new actions cannot be cast back to the old type: remove them first.
  await db.execute(sql`
   DELETE FROM "activity_logs" WHERE "action" IN ('sign_out_everywhere', 'sign_in_method_added');
   ALTER TABLE "activity_logs" ALTER COLUMN "action" SET DATA TYPE text;
  DROP TYPE "public"."enum_activity_logs_action";
  CREATE TYPE "public"."enum_activity_logs_action" AS ENUM('create', 'status_change', 'delete');
  ALTER TABLE "activity_logs" ALTER COLUMN "action" SET DATA TYPE "public"."enum_activity_logs_action" USING "action"::"public"."enum_activity_logs_action";
  DROP INDEX "users_account_status_idx";
  DROP INDEX "activity_logs_target_id_idx";
  ALTER TABLE "users" DROP COLUMN "name";
  ALTER TABLE "users" DROP COLUMN "account_status";
  ALTER TABLE "users" DROP COLUMN "password_set_at";
  ALTER TABLE "users" DROP COLUMN "last_sign_in_at";
  ALTER TABLE "users" DROP COLUMN "method_added_notice";
  ALTER TABLE "activity_logs" DROP COLUMN "field";
  ALTER TABLE "activity_logs" DROP COLUMN "note";
  DROP TYPE "public"."enum_users_account_status";
  DROP TYPE "public"."enum_users_method_added_notice";`)
}
