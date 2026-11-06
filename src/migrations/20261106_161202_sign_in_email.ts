import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// Email sign-in: the `magic_links` table (hashed sign-in link tokens) and Payload's email
// verification columns on `users`. Every account that exists before this migration was made by
// Google sign-in (verified email), the seed script or an admin, so all of them are marked
// verified: `_verified` (Payload's gate for password sign-in) and `email_verified_at` (our
// record) together.
export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "magic_links" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"email" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"used_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "users" ADD COLUMN "_verified" boolean;
  ALTER TABLE "users" ADD COLUMN "_verificationtoken" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "magic_links_id" integer;
  CREATE UNIQUE INDEX "magic_links_token_hash_idx" ON "magic_links" USING btree ("token_hash");
  CREATE INDEX "magic_links_email_idx" ON "magic_links" USING btree ("email");
  CREATE INDEX "magic_links_expires_at_idx" ON "magic_links" USING btree ("expires_at");
  CREATE INDEX "magic_links_updated_at_idx" ON "magic_links" USING btree ("updated_at");
  CREATE INDEX "magic_links_created_at_idx" ON "magic_links" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_magic_links_fk" FOREIGN KEY ("magic_links_id") REFERENCES "public"."magic_links"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_magic_links_id_idx" ON "payload_locked_documents_rels" USING btree ("magic_links_id");
  UPDATE "users" SET "_verified" = true, "email_verified_at" = COALESCE("email_verified_at", now());`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "magic_links" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "magic_links" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_magic_links_fk";
  
  DROP INDEX "payload_locked_documents_rels_magic_links_id_idx";
  ALTER TABLE "users" DROP COLUMN "_verified";
  ALTER TABLE "users" DROP COLUMN "_verificationtoken";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "magic_links_id";`)
}
