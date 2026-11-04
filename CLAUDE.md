# Konnected web app

Managed platform: startups submit paid project assignments, university students deliver them. Konnected approves, matches, coordinates and handles payment. It is not a job board.

Stack: Next.js (App Router) + Payload CMS 3 (TypeScript) + PostgreSQL, Docker Compose on one EU VPS behind Caddy. Served on `app.<domain>`. English and Norwegian (`/en`, `/no`). Package manager: pnpm.

## Source of truth

Order of authority, highest first. If two disagree, the higher one wins and the lower one gets fixed.

1. Notion **About us**: product model and rules. https://app.notion.com/p/40e337b89c3d803180effbf1641edf2e
2. Notion **Engineering draft**: build and hosting plan, data model, permission matrix, phases. https://app.notion.com/p/40e337b89c3d80a39075c62e80cee546
3. Notion **Technical Kanban**: the work items. Database `7b19ac01-b3cf-4cb5-8b38-7225d9886592`, data source `9df9048f-f231-421e-8a0d-a71869aabb91`. https://app.notion.com/p/7b19ac01b3cf4cb58b387225d9886592
4. Notion **Business plan**: strategy, read on demand. https://app.notion.com/p/40e337b89c3d81069542eaa3a66a0990
5. The `konnected-*` skills: copies of the rules plus dated research notes.
6. This repo's code and tests: what is actually built.

For library behaviour, the installed version and its types beat any note or memory. Re-check versions before relying on them.

## Always

- Use the `konnected-*` skills. Start with `konnected-product-rules`.
- Companies never see or search students. A company sees a student only after Konnected selects them, and only what the student agreed to share.
- Login is Google sign-in only. No passwords, no Feide, no other SSO. Role comes from our database. `admin` only from the `ADMIN_EMAILS` allowlist.
- Konnected approves every company and every project before students see it.
- Enforce access on the server (Payload access functions and hooks), for REST, GraphQL and the Local API. In the Local API pass `overrideAccess: false` for anything done for a user.
- Every access or status change comes with a test run as each role.
- Work one Technical Kanban card at a time. A card is done only when its acceptance criteria pass.
- Stay inside version 1 scope. Ask before adding anything from the "after launch" list.
- Run lint, typecheck and tests before saying work is done. Report failures as they are.
- Work on a branch (`feat/<short-name>`), not on `main`. Do not push to `main` and do not force-push.

## Never

- Commit secrets, or put them in an image or a build argument. `.env` stays out of git. Only `NEXT_PUBLIC_*` values may be build args.
- Log tokens, cookies, authorization headers or personal data.
- Bypass access control without a written reason in the code.
- Change Notion pages unless asked. The only allowed Notion write in a normal session is the Status of the card you are working on. The original "Task Management" database is read-only.
- Expose student personal data to a company, even in a hidden field.

## Version 1 scope

In: Google sign-in and role choice, university email check, student profile and CV, company registration and approval, project submission and review, project list with filters, apply, manual matching, deliverables, admin queues and payment log (manual), EN/NO.

Out until after launch: public introduction site, built-in scheduler and calendar sync, messaging, agreements and e-signature, payment integration, reviews display, partner roles, analytics.

## Versions to start from (re-verify, pinned 2026-11-04)

Node 24 (Payload needs `^22.23.4 || >=24.22.1`). `payload`, `@payloadcms/next` and `@payloadcms/db-postgres` the same exact version (3.93.0). Next.js `>=16.4.5 <17`. PostgreSQL 18. Caddy pinned to a version, never `latest`.

## Commands

Run `fnm use` first (Node 24, from `.nvmrc`). Docker must be running for `dev`.

- `pnpm dev`: start local PostgreSQL 18 (Docker Compose, host port 5433), then `next dev` on port 3000.
- `pnpm build`, `pnpm start`: production build and run.
- `pnpm lint`, `pnpm typecheck` (runs `next typegen` then `tsc --noEmit`), `pnpm format:check`, `pnpm format`.
- `pnpm migrate`, `pnpm migrate:create`: Payload migrations in `src/migrations`.
- `pnpm generate:types`, `pnpm generate:importmap`: Payload generated files.
- `pnpm db:up`, `pnpm db:down`: local PostgreSQL only.
- `test`: not set up yet. It comes with the CI and access-testing cards. Until then, report "no tests exist".

## Open decisions

Domain name, VPS provider, university email domains, file storage, fee and payment model, re-applying after withdrawing an application, account recovery. Do not guess these. Ask.
