import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Make a pause and "Sign out everywhere" hold against writes that started before them.
 *
 * Payload 3.93 writes the whole user row, and the whole `users_sessions` list, from the copy it
 * read when an operation began: a password sign-in (`addSessionToUser`, after tens of milliseconds
 * of hashing), a sign-out, any update of the user (a profile save copies the name). It takes no
 * row lock. A write like that, started before the team paused the account or ended its sessions,
 * would put `account_status = 'active'` and the old sessions back.
 *
 * - `users.account_status_version` goes up by one with every status change (Users hook). On any
 *   UPDATE of a user, the trigger keeps the stored status when the write carries an older
 *   version: that write was built from a row read before the last status change. Under READ
 *   COMMITTED a waiting UPDATE is checked against the newest row, so this holds under races too.
 *   The version itself never goes down.
 * - `users.sessions_valid_after` is set when all sessions end (endAllSessions). It never goes
 *   down, and a session row is not stored when its account is paused or when it was created at
 *   or before that time. The row is skipped (not an error), so the rest of the stale write (a
 *   name, the sign-in time) still goes through; Payload then finds no session for that token.
 *
 * Only adds columns, functions and triggers. A release without the new hook still works on this
 * schema: its status writes carry the version they read, which is not older than the row, so they
 * go through (strictly older is required to keep the stored status).
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ADD COLUMN "account_status_version" numeric DEFAULT 0;
  ALTER TABLE "users" ADD COLUMN "sessions_valid_after" timestamp(3) with time zone;

  CREATE FUNCTION "users_hold_account_state"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW."account_status" IS DISTINCT FROM OLD."account_status"
       AND COALESCE(NEW."account_status_version", 0) < COALESCE(OLD."account_status_version", 0) THEN
      NEW."account_status" := OLD."account_status";
    END IF;
    NEW."account_status_version" :=
      GREATEST(COALESCE(OLD."account_status_version", 0), COALESCE(NEW."account_status_version", 0));
    IF OLD."sessions_valid_after" IS NOT NULL
       AND (NEW."sessions_valid_after" IS NULL
            OR NEW."sessions_valid_after" < OLD."sessions_valid_after") THEN
      NEW."sessions_valid_after" := OLD."sessions_valid_after";
    END IF;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER "users_hold_account_state"
    BEFORE UPDATE ON "users"
    FOR EACH ROW EXECUTE FUNCTION "users_hold_account_state"();

  CREATE FUNCTION "users_sessions_only_valid"() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE
    owner_status text;
    valid_after timestamp(3) with time zone;
  BEGIN
    SELECT "account_status"::text, "sessions_valid_after" INTO owner_status, valid_after
      FROM "users" WHERE "id" = NEW."_parent_id";
    IF owner_status = 'paused' THEN
      RETURN NULL;
    END IF;
    IF valid_after IS NOT NULL
       AND (NEW."created_at" IS NULL OR NEW."created_at" <= valid_after) THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END
  $$;

  CREATE TRIGGER "users_sessions_only_valid"
    BEFORE INSERT OR UPDATE ON "users_sessions"
    FOR EACH ROW EXECUTE FUNCTION "users_sessions_only_valid"();`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TRIGGER IF EXISTS "users_sessions_only_valid" ON "users_sessions";
  DROP FUNCTION IF EXISTS "users_sessions_only_valid"();
  DROP TRIGGER IF EXISTS "users_hold_account_state" ON "users";
  DROP FUNCTION IF EXISTS "users_hold_account_state"();
  ALTER TABLE "users" DROP COLUMN "account_status_version";
  ALTER TABLE "users" DROP COLUMN "sessions_valid_after";`)
}
