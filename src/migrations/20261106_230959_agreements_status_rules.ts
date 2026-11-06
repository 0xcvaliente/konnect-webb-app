import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Agreement statuses move only forward, and a withdrawn agreement stays withdrawn.
 *
 * Payload writes the whole row from the copy it read, with no row lock. A signature or the PDF
 * job that read `awaiting_party` (or `generating`) before the team withdrew the agreement would
 * otherwise write its status over `void`, and a withdrawn agreement could be signed and open a
 * gate. The app now locks the row first (lib/agreements/generate.ts, lockAgreement); this trigger
 * is the same rule in the database. Under READ COMMITTED a waiting UPDATE is checked against the
 * newest row, so it holds under races too.
 *
 * The allowed moves are AGREEMENT_TRANSITIONS in lib/agreements/fields.ts. A signed agreement keeps
 * its existing rule (only `emailed_at`, once). A `void` row does not change at all.
 * No schema change: only the trigger function is replaced.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE OR REPLACE FUNCTION "agreements_keep_signed"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Agreements are kept' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'signed' AND (
      (to_jsonb(NEW) - 'emailed_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'emailed_at' - 'updated_at')
      OR (OLD."emailed_at" IS NOT NULL AND NEW."emailed_at" IS DISTINCT FROM OLD."emailed_at")
    ) THEN
      RAISE EXCEPTION 'A signed agreement cannot be changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'void'
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
      RAISE EXCEPTION 'A withdrawn agreement cannot be changed' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
         (OLD."status" = 'generating' AND NEW."status" IN ('awaiting_party', 'failed', 'void'))
      OR (OLD."status" = 'awaiting_party' AND NEW."status" IN ('awaiting_konnected', 'void'))
      OR (OLD."status" = 'awaiting_konnected' AND NEW."status" IN ('signed', 'void'))
      OR (OLD."status" = 'failed' AND NEW."status" = 'void')
    ) THEN
      RAISE EXCEPTION 'An agreement cannot move from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $$;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  CREATE OR REPLACE FUNCTION "agreements_keep_signed"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Agreements are kept' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'signed' AND (
      (to_jsonb(NEW) - 'emailed_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'emailed_at' - 'updated_at')
      OR (OLD."emailed_at" IS NOT NULL AND NEW."emailed_at" IS DISTINCT FROM OLD."emailed_at")
    ) THEN
      RAISE EXCEPTION 'A signed agreement cannot be changed' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $$;`)
}
