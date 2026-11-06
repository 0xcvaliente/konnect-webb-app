import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

/**
 * Company registration: organisation number, contact person, website, sector as a fixed list,
 * an optional logo (new private upload collection `company_logos`), the Konnected owner, the
 * approval date, a copy of the logo on projects, and the one-user rule both ways (unique
 * `companies.user_id` and unique `users.company_id`).
 *
 * Hand edits to the generated SQL:
 * - `sector` was free text. Values that match a new key (any case) keep it, empty ones become
 *   NULL and anything else becomes 'other', so the type change cannot fail on old rows.
 * - `companies.user_id` is filled from `users.company_id` for existing companies. If two users
 *   already point at one company, creating the unique index on `users.company_id` fails and the
 *   whole migration rolls back: that data needs a person to decide which user stays.
 */

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_companies_sector" AS ENUM('software', 'food', 'energy', 'retail', 'health', 'media', 'other');
  CREATE TABLE "company_logos" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"uploaded_by_id" integer,
  	"original_name" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric
  );
  
  DROP INDEX "users_company_idx";
  UPDATE "companies" SET "sector" = CASE
    WHEN "sector" IS NULL OR btrim("sector") = '' THEN NULL
    WHEN lower(btrim("sector")) IN ('software', 'food', 'energy', 'retail', 'health', 'media', 'other') THEN lower(btrim("sector"))
    ELSE 'other' END;
  ALTER TABLE "companies" ALTER COLUMN "sector" SET DATA TYPE "public"."enum_companies_sector" USING "sector"::"public"."enum_companies_sector";
  ALTER TABLE "companies" ADD COLUMN "org_number" varchar;
  ALTER TABLE "companies" ADD COLUMN "contact_name" varchar;
  ALTER TABLE "companies" ADD COLUMN "contact_role" varchar;
  ALTER TABLE "companies" ADD COLUMN "website" varchar;
  ALTER TABLE "companies" ADD COLUMN "logo_id" integer;
  ALTER TABLE "companies" ADD COLUMN "user_id" integer;
  UPDATE "companies" SET "user_id" = "users"."id" FROM "users" WHERE "users"."company_id" = "companies"."id";
  ALTER TABLE "companies" ADD COLUMN "team_owner_id" integer;
  ALTER TABLE "companies" ADD COLUMN "approved_at" timestamp(3) with time zone;
  ALTER TABLE "projects" ADD COLUMN "company_logo_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "company_logos_id" integer;
  ALTER TABLE "company_logos" ADD CONSTRAINT "company_logos_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "company_logos_uploaded_by_idx" ON "company_logos" USING btree ("uploaded_by_id");
  CREATE INDEX "company_logos_updated_at_idx" ON "company_logos" USING btree ("updated_at");
  CREATE INDEX "company_logos_created_at_idx" ON "company_logos" USING btree ("created_at");
  CREATE UNIQUE INDEX "company_logos_filename_idx" ON "company_logos" USING btree ("filename");
  ALTER TABLE "companies" ADD CONSTRAINT "companies_logo_id_company_logos_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."company_logos"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "companies" ADD CONSTRAINT "companies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "companies" ADD CONSTRAINT "companies_team_owner_id_users_id_fk" FOREIGN KEY ("team_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "projects" ADD CONSTRAINT "projects_company_logo_id_company_logos_id_fk" FOREIGN KEY ("company_logo_id") REFERENCES "public"."company_logos"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_company_logos_fk" FOREIGN KEY ("company_logos_id") REFERENCES "public"."company_logos"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "companies_org_number_idx" ON "companies" USING btree ("org_number");
  CREATE INDEX "companies_logo_idx" ON "companies" USING btree ("logo_id");
  CREATE UNIQUE INDEX "companies_user_idx" ON "companies" USING btree ("user_id");
  CREATE INDEX "companies_team_owner_idx" ON "companies" USING btree ("team_owner_id");
  CREATE INDEX "projects_company_logo_idx" ON "projects" USING btree ("company_logo_id");
  CREATE INDEX "payload_locked_documents_rels_company_logos_id_idx" ON "payload_locked_documents_rels" USING btree ("company_logos_id");
  CREATE UNIQUE INDEX "users_company_idx" ON "users" USING btree ("company_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  // Hand-written order: drop the foreign keys before the table they point at. `sector` goes back
  // to free text with its key as the value.
  await db.execute(sql`
  ALTER TABLE "companies" DROP CONSTRAINT "companies_logo_id_company_logos_id_fk";
  ALTER TABLE "companies" DROP CONSTRAINT "companies_user_id_users_id_fk";
  ALTER TABLE "companies" DROP CONSTRAINT "companies_team_owner_id_users_id_fk";
  ALTER TABLE "projects" DROP CONSTRAINT "projects_company_logo_id_company_logos_id_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_company_logos_fk";
  DROP INDEX "companies_org_number_idx";
  DROP INDEX "companies_logo_idx";
  DROP INDEX "companies_user_idx";
  DROP INDEX "companies_team_owner_idx";
  DROP INDEX "projects_company_logo_idx";
  DROP INDEX "payload_locked_documents_rels_company_logos_id_idx";
  DROP INDEX "users_company_idx";
  ALTER TABLE "companies" ALTER COLUMN "sector" SET DATA TYPE varchar USING "sector"::text;
  CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");
  ALTER TABLE "companies" DROP COLUMN "org_number";
  ALTER TABLE "companies" DROP COLUMN "contact_name";
  ALTER TABLE "companies" DROP COLUMN "contact_role";
  ALTER TABLE "companies" DROP COLUMN "website";
  ALTER TABLE "companies" DROP COLUMN "logo_id";
  ALTER TABLE "companies" DROP COLUMN "user_id";
  ALTER TABLE "companies" DROP COLUMN "team_owner_id";
  ALTER TABLE "companies" DROP COLUMN "approved_at";
  ALTER TABLE "projects" DROP COLUMN "company_logo_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "company_logos_id";
  DROP TABLE "company_logos";
  DROP TYPE "public"."enum_companies_sector";`)
}
