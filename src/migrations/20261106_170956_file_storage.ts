import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

// File storage: three private upload collections (`cvs`, `deliverable_files`, `brief_files`)
// whose files live on the server's disk under MEDIA_DIR, and the links to them:
// `student_profiles.cv_id` and `privacy_share_cv` (nothing shared by default),
// `matches.shared_info_cv_id` (the CV a company may open, set only when the student shares it),
// `projects_rels` (brief attachments) and `deliverables_rels` (deliverable files). Only new tables
// and nullable columns, so the previous app version keeps working against this schema.
//
// down(): the generated version dropped the tables with CASCADE (which also drops the foreign
// keys pointing at them) and then dropped those keys again, which fails. IF EXISTS fixes that.

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "projects_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"brief_files_id" integer
  );
  
  CREATE TABLE "deliverables_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"deliverable_files_id" integer
  );
  
  CREATE TABLE "cvs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"owner_id" integer NOT NULL,
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
  
  CREATE TABLE "deliverable_files" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"match_id" integer NOT NULL,
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
  
  CREATE TABLE "brief_files" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"company_id" integer NOT NULL,
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
  
  ALTER TABLE "student_profiles" ADD COLUMN "cv_id" integer;
  ALTER TABLE "student_profiles" ADD COLUMN "privacy_share_cv" boolean DEFAULT false;
  ALTER TABLE "matches" ADD COLUMN "shared_info_cv_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cvs_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "deliverable_files_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "brief_files_id" integer;
  ALTER TABLE "projects_rels" ADD CONSTRAINT "projects_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "projects_rels" ADD CONSTRAINT "projects_rels_brief_files_fk" FOREIGN KEY ("brief_files_id") REFERENCES "public"."brief_files"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "deliverables_rels" ADD CONSTRAINT "deliverables_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."deliverables"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "deliverables_rels" ADD CONSTRAINT "deliverables_rels_deliverable_files_fk" FOREIGN KEY ("deliverable_files_id") REFERENCES "public"."deliverable_files"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cvs" ADD CONSTRAINT "cvs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "deliverable_files" ADD CONSTRAINT "deliverable_files_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "deliverable_files" ADD CONSTRAINT "deliverable_files_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "brief_files" ADD CONSTRAINT "brief_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "projects_rels_order_idx" ON "projects_rels" USING btree ("order");
  CREATE INDEX "projects_rels_parent_idx" ON "projects_rels" USING btree ("parent_id");
  CREATE INDEX "projects_rels_path_idx" ON "projects_rels" USING btree ("path");
  CREATE INDEX "projects_rels_brief_files_id_idx" ON "projects_rels" USING btree ("brief_files_id");
  CREATE INDEX "deliverables_rels_order_idx" ON "deliverables_rels" USING btree ("order");
  CREATE INDEX "deliverables_rels_parent_idx" ON "deliverables_rels" USING btree ("parent_id");
  CREATE INDEX "deliverables_rels_path_idx" ON "deliverables_rels" USING btree ("path");
  CREATE INDEX "deliverables_rels_deliverable_files_id_idx" ON "deliverables_rels" USING btree ("deliverable_files_id");
  CREATE INDEX "cvs_owner_idx" ON "cvs" USING btree ("owner_id");
  CREATE INDEX "cvs_updated_at_idx" ON "cvs" USING btree ("updated_at");
  CREATE INDEX "cvs_created_at_idx" ON "cvs" USING btree ("created_at");
  CREATE UNIQUE INDEX "cvs_filename_idx" ON "cvs" USING btree ("filename");
  CREATE INDEX "deliverable_files_match_idx" ON "deliverable_files" USING btree ("match_id");
  CREATE INDEX "deliverable_files_uploaded_by_idx" ON "deliverable_files" USING btree ("uploaded_by_id");
  CREATE INDEX "deliverable_files_updated_at_idx" ON "deliverable_files" USING btree ("updated_at");
  CREATE INDEX "deliverable_files_created_at_idx" ON "deliverable_files" USING btree ("created_at");
  CREATE UNIQUE INDEX "deliverable_files_filename_idx" ON "deliverable_files" USING btree ("filename");
  CREATE INDEX "brief_files_company_idx" ON "brief_files" USING btree ("company_id");
  CREATE INDEX "brief_files_updated_at_idx" ON "brief_files" USING btree ("updated_at");
  CREATE INDEX "brief_files_created_at_idx" ON "brief_files" USING btree ("created_at");
  CREATE UNIQUE INDEX "brief_files_filename_idx" ON "brief_files" USING btree ("filename");
  ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_cv_id_cvs_id_fk" FOREIGN KEY ("cv_id") REFERENCES "public"."cvs"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "matches" ADD CONSTRAINT "matches_shared_info_cv_id_cvs_id_fk" FOREIGN KEY ("shared_info_cv_id") REFERENCES "public"."cvs"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cvs_fk" FOREIGN KEY ("cvs_id") REFERENCES "public"."cvs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_deliverable_files_fk" FOREIGN KEY ("deliverable_files_id") REFERENCES "public"."deliverable_files"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_brief_files_fk" FOREIGN KEY ("brief_files_id") REFERENCES "public"."brief_files"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "student_profiles_cv_idx" ON "student_profiles" USING btree ("cv_id");
  CREATE INDEX "matches_shared_info_shared_info_cv_idx" ON "matches" USING btree ("shared_info_cv_id");
  CREATE INDEX "payload_locked_documents_rels_cvs_id_idx" ON "payload_locked_documents_rels" USING btree ("cvs_id");
  CREATE INDEX "payload_locked_documents_rels_deliverable_files_id_idx" ON "payload_locked_documents_rels" USING btree ("deliverable_files_id");
  CREATE INDEX "payload_locked_documents_rels_brief_files_id_idx" ON "payload_locked_documents_rels" USING btree ("brief_files_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "projects_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "deliverables_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cvs" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "deliverable_files" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "brief_files" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "projects_rels" CASCADE;
  DROP TABLE "deliverables_rels" CASCADE;
  DROP TABLE "cvs" CASCADE;
  DROP TABLE "deliverable_files" CASCADE;
  DROP TABLE "brief_files" CASCADE;
  ALTER TABLE "student_profiles" DROP CONSTRAINT IF EXISTS "student_profiles_cv_id_cvs_id_fk";
  
  ALTER TABLE "matches" DROP CONSTRAINT IF EXISTS "matches_shared_info_cv_id_cvs_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_cvs_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_deliverable_files_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_brief_files_fk";
  
  DROP INDEX IF EXISTS "student_profiles_cv_idx";
  DROP INDEX IF EXISTS "matches_shared_info_shared_info_cv_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_cvs_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_deliverable_files_id_idx";
  DROP INDEX IF EXISTS "payload_locked_documents_rels_brief_files_id_idx";
  ALTER TABLE "student_profiles" DROP COLUMN "cv_id";
  ALTER TABLE "student_profiles" DROP COLUMN "privacy_share_cv";
  ALTER TABLE "matches" DROP COLUMN "shared_info_cv_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cvs_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "deliverable_files_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "brief_files_id";`)
}
