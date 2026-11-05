# Konnected web app

Managed platform where startups submit paid project assignments and university students deliver
them. Konnected approves, matches, coordinates and handles payment.

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

| Command                             | What it does                               |
| ----------------------------------- | ------------------------------------------ |
| `pnpm dev`                          | Start PostgreSQL (Docker), then `next dev` |
| `pnpm build` / `pnpm start`         | Production build / run the build           |
| `pnpm lint`                         | ESLint                                     |
| `pnpm typecheck`                    | `next typegen`, then `tsc --noEmit`        |
| `pnpm format` / `pnpm format:check` | Prettier write / check                     |
| `pnpm db:up` / `pnpm db:down`       | Start / stop local PostgreSQL              |
| `pnpm migrate`                      | Run migrations in `src/migrations`         |
| `pnpm migrate:create`               | Create a migration                         |
| `pnpm generate:types`               | Regenerate `src/payload-types.ts`          |
| `pnpm generate:importmap`           | Regenerate the Payload admin import map    |

There is no `test` command yet. The test runner and CI come with their own cards.

Reset the local database: `pnpm db:down && docker volume rm konnect-webb-app_pgdata`.

## Notes

- Versions are pinned exactly. `payload`, `@payloadcms/next` and `@payloadcms/db-postgres` must stay on
  the same version.
- pnpm 12 blocks packages newer than its minimum release age. `pnpm-workspace.yaml` lists the
  Payload 3.93.0 packages as exceptions. Remove them when 3.93.0 is old enough.
- Payload adds a default `users` collection with email and password login when none is defined.
  That is a placeholder until the data model card. Do not deploy this scaffold.
- Never commit `.env`. Only `NEXT_PUBLIC_*` values may be Docker build args.
