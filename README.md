# Konnected web app

Managed platform where startups submit project assignments, paid or unpaid, and university
students deliver them. Konnected approves, matches, coordinates and handles payment.

Stack: Next.js (App Router), Payload CMS 3 (TypeScript), PostgreSQL 18. Package manager: pnpm.

This repo is the scaffold only. Collections, Google sign-in and screens come with later cards.

## Requirements

- Node 24 (`.nvmrc`). Use [fnm](https://github.com/Schniz/fnm) or nvm: `fnm use`.
- pnpm 10 or newer: `npm i -g pnpm`.
- Docker with Compose, running. It starts PostgreSQL 18 for local development.

## Setup

```bash
cp .env.example .env     # then set PAYLOAD_SECRET: openssl rand -hex 32
pnpm install
pnpm dev                 # starts PostgreSQL in Docker, then the app
```

The app runs on <http://localhost:3000>. The Payload admin is on <http://localhost:3000/admin>.

PostgreSQL listens on `127.0.0.1:5433` (not 5432, so it does not clash with a local install).
`DATABASE_URL` in `.env.example` already points there.

## Commands

| Command                             | What it does                                                         |
| ----------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                          | Start PostgreSQL (Docker), run migrations, then `next dev`           |
| `pnpm build` / `pnpm start`         | Production build / run the build                                     |
| `pnpm lint`                         | ESLint                                                               |
| `pnpm typecheck`                    | `next typegen`, then `tsc --noEmit`                                  |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                               |
| `pnpm db:up` / `pnpm db:down`       | Start / stop local PostgreSQL                                        |
| `pnpm migrate`                      | Run migrations in `src/migrations`                                   |
| `pnpm test`                         | Vitest: access and workflow tests on a real PostgreSQL test database |
| `pnpm seed`                         | Dev seed: admin, student, company, one project per status            |
| `pnpm migrate:create`               | Create a migration                                                   |
| `pnpm generate:types`               | Regenerate `src/payload-types.ts`                                    |
| `pnpm generate:importmap`           | Regenerate the Payload admin import map                              |

`pnpm test` needs the Docker PostgreSQL running (`pnpm db:up`). It creates and migrates a separate `<name>_test` database, so it never touches your dev data. The seed refuses to run in production. Local seed accounts use a throwaway password written in `src/seed.ts`.

Schema changes always go through a committed migration (`pnpm migrate:create`). Schema push is off.

Reset the local database: `pnpm db:down && docker volume rm konnect-webb-app_pgdata`.

## File storage and backups

Uploaded files live on the server's own disk in `MEDIA_DIR` (default `./media`, git-ignored), one
subdirectory per upload collection:

| Collection          | What                      | Types                                       | Limit |
| ------------------- | ------------------------- | ------------------------------------------- | ----- |
| `cvs`               | A student's CV            | PDF                                         | 10 MB |
| `deliverable-files` | Files on a deliverable    | PDF, Word, Excel, PowerPoint, PNG, JPG, zip | 50 MB |
| `brief-files`       | Company brief attachments | PDF, Word, Excel, PowerPoint, PNG, JPG      | 20 MB |

- Files are never public. They are served only by `/api/<collection>/file/<name>`, which applies the
  collection's read access, always as a download (`Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`). Never put `MEDIA_DIR` under
  `public/` (the app refuses to start) and never serve it from Caddy or another static route.
- The type is checked from the file's first bytes, and the name must match it (a PNG called
  `cv.pdf` is refused). Word, Excel and PowerPoint means `.docx`, `.xlsx`, `.pptx` only. Stored files
  get a random name; the uploaded name is kept as `originalName` for display.
- Files not in use are limited per account, so nobody can fill the disk (which PostgreSQL shares):
  3 CVs not on the student's profile, 20 brief files not on a submitted project (files on a draft
  count), 20 deliverable files not on a deliverable. Further uploads get `429` until the person uses
  or deletes some. Admins have no limit. A job removes files nothing has used for 7 days every night
  at 03:15 (each student keeps their newest CV); the app schedules and runs it itself
  (`src/jobs`, started from `src/instrumentation.ts`). Rules: `src/lib/uploads/unused.ts`.
- Who can read what: `src/collections/Cvs.ts`, `DeliverableFiles.ts`, `BriefFiles.ts` and
  `src/access/files.ts`. Tests: `tests/access/files.test.ts`.

Backups (production, see the deploy card): the database backup alone is not enough. Back up
`MEDIA_DIR` off the server on the same schedule and retention as the database (14 days,
encrypted), and restore both together: a row in `cvs`, `deliverable_files` or `brief_files`
without its file gives an error on download. In Docker, mount `MEDIA_DIR` as a named volume so a new
image keeps the files. A restore test counts only when a downloaded file opens.

## Notes

- Versions are pinned exactly. `payload`, `@payloadcms/next` and `@payloadcms/db-postgres` must stay on
  the same version.
- pnpm 12 blocks packages newer than its minimum release age. `pnpm-workspace.yaml` lists the
  Payload 3.93.0 packages as exceptions. Remove them when 3.93.0 is old enough.
- Login is provisional (Google, email magic link, or email and password). The collections and access rules are built. The sign-in flows themselves are not: until the auth card, only the Payload admin password login works, and the first-user endpoint is closed. Create an admin with `pnpm seed`.
- Design base: Tailwind 4 and shadcn/ui with the Estuary tokens (`src/app/(frontend)/globals.css`,
  only loaded by our own pages, never by the Payload admin). UI primitives live in `src/components/ui`,
  layouts (`SiteShell`, `TeamShell`) in `src/components/app`. The style guide is at
  <http://localhost:3000/en/dev/design> in development; it does not exist in production.
- Our pages get a nonce-based Content-Security-Policy from `src/proxy.ts` and render per request.
  `/admin` and `/api` keep the static headers in `next.config.ts`.
- Never commit `.env`. Only `NEXT_PUBLIC_*` values may be Docker build args.
