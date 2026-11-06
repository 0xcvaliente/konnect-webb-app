# Konnected web app

Managed platform: startups submit project assignments, paid or unpaid (the company chooses, Konnected decides), and university students deliver them. Konnected approves, matches, coordinates and handles payment. It is not a job board.

Stack: Next.js (App Router) + Payload CMS 3 (TypeScript) + PostgreSQL, Docker Compose on one EU server (netcup) behind Caddy. Served on `app.konnected.no` (read it from `APP_URL`, never hard-code it). English and Norwegian (`/en`, `/no`). Package manager: pnpm.

## Source of truth

Order of authority, highest first. If two disagree, the higher one wins and the lower one gets fixed.

1. Notion **About us**: product model and rules. https://app.notion.com/p/40e337b89c3d803180effbf1641edf2e
2. **Engineering draft** (moved from Notion to the owner's Obsidian vault on 2026-11-06, Notion was out of space): `~/Documents/Obsidian Vault/Konnected/Engineering draft.md`. Build and hosting plan, data model, permission matrix, phases, decision log.
3. **Technical Kanban** (same move): one note per card in `~/Documents/Obsidian Vault/Konnected/Technical Kanban/`, with `status`, `priority`, `phase`, `due` and `pr` in the frontmatter; the board is `Technical Kanban.base`. The old Notion database is read-only history.
4. Notion **Business plan**: strategy, read on demand. https://app.notion.com/p/40e337b89c3d81069542eaa3a66a0990
5. The `konnected-*` skills: copies of the rules plus dated research notes.
6. This repo's code and tests: what is actually built.

For library behaviour, the installed version and its types beat any note or memory. Re-check versions before relying on them.

## Always

- Use the `konnected-*` skills. Start with `konnected-product-rules`.
- Companies never see or search students. A company sees a student only after Konnected selects them, and only what the student agreed to share.
- Login (PROVISIONAL, owner decision 2026-11-05): Google sign-in, email magic link, or email and password. No Feide, no other SSO, no university email check. Role comes from our database. `admin` only from the `ADMIN_EMAILS` allowlist and only for a verified email. Link sign-in methods to one account by verified email only. Decided 2026-11-05: "SSO" is Google only; no automated student check for the pilot (Konnected reviews every profile); admins sign in with Google only; passwords need 15+ characters, breached-password check, email verified before first sign-in, lockout after 5 tries for 15 minutes. Account recovery is a manual identity check (2026-11-06). Details in the Notion Engineering draft, section 12.
- Konnected approves every company and every project before students see it.
- Enforce access on the server (Payload access functions and hooks), for REST, GraphQL and the Local API. In the Local API pass `overrideAccess: false` for anything done for a user.
- Every access or status change comes with a test run as each role.
- Work one Technical Kanban card at a time. A card is done only when its acceptance criteria pass.
- Stay inside version 1 scope. Ask before adding anything from the "after launch" list.
- Run lint, typecheck and tests before saying work is done. Report failures as they are.
- Work on a branch (`feat/<short-name>`), not on `main`. Do not push to `main` and do not force-push. `.claude/settings.json` enforces this, blocks reading `.env` and `credentials/`, and formats changed files.
- Build screens on the Estuary look from the mockups (`konnected-design-system` skill): teal, primary `#005F73`, pale mint header band. Not blue and amber.
- Only EU-owned services and processors (owner decision 2026-11-06), and only things that fit the hosting budget of 15 EUR a month.
- No lost data and no downtime the owner can notice: the database is backed up continuously off the server, and deploys swap containers without dropping requests. So migrations must be backward compatible with the running version (add first, remove in a later deploy).

## Never

- Commit secrets, or put them in an image or a build argument. `.env` stays out of git. Only `NEXT_PUBLIC_*` values may be build args.
- Log tokens, cookies, authorization headers or personal data.
- Bypass access control without a written reason in the code.
- Change Notion pages unless asked. Notion (About us, Business plan, the old Task Management database) is read-only. In the Obsidian vault, the only change allowed in a normal session is the `status` (and `pr`) of the card you are working on; other engineering edits need the user's ask.
- Expose student personal data to a company, even in a hidden field.

## Version 1 scope

In: sign-in (Google, magic link, password) and role choice, student profile and CV, company registration and approval, project submission and review, project list with filters, apply, manual matching, deliverables, admin queues and payment log (manual), agreements (Konnected's uploaded Word templates filled per project into a PDF, signed in the app with a tick and a typed name, no BankID, emailed to both; the company signs before publishing, the student before work starts), Ask Konnected (a question form to the team, not messaging), EN/NO.

Out until after launch: public introduction site, built-in scheduler and calendar sync, messaging, BankID or other external e-signature services, payment integration (Stripe, Fiken sync), reviews display, partner roles, analytics.

## Versions to start from (re-verify, pinned 2026-11-04)

Node 24 (Payload needs `^22.23.4 || >=24.22.1`). `payload`, `@payloadcms/next` and `@payloadcms/db-postgres` the same exact version (3.93.0). Next.js `>=16.4.5 <17`. PostgreSQL 18. Caddy pinned to a version, never `latest`.

## Commands

Run `fnm use` first (Node 24, from `.nvmrc`). Docker must be running for `dev`.

- `pnpm dev`: start local PostgreSQL 18 (Docker Compose, host port 5433), run migrations, then `next dev` on port 3000.
- `pnpm test`: Vitest access and workflow tests on a real PostgreSQL test database (`<name>_test`, created and migrated for each run). Needs `pnpm db:up`.
- `pnpm seed`: dev seed (admin, student, company, one project per status). Repeatable. Refuses to run in production.
- `pnpm build`, `pnpm start`: production build and run.
- `pnpm lint`, `pnpm typecheck` (runs `next typegen` then `tsc --noEmit`), `pnpm format:check`, `pnpm format`.
- `pnpm migrate`, `pnpm migrate:create`: Payload migrations in `src/migrations`. Schema push is off. Every schema change needs a committed migration.
- `pnpm generate:types`, `pnpm generate:importmap`: Payload generated files.
- `pnpm db:up`, `pnpm db:down`: local PostgreSQL only.

## Decided (owner, 5 and 6 Nov 2026)

- Money: fixed price per project set by Konnected at review; 25% VAT; 14-day payment terms; students paid in the monthly pay run after the company has paid; manual payment log in the pilot; Stripe after launch; Fiken for accounting; no fee on unpaid projects in the pilot.
- Rules: no re-applying after withdrawing; at most 2 running projects per student; one person per company account; one round of fixes within 7 days; the company may cancel after selection and Konnected agrees the next step.
- Promises: profile review 2 working days; decision 3 working days after applications close; Ask Konnected answers 2 working days; company approval a few working days.
- Team: each company has an owner from the team (Oliver, Amanda, Clifford, Julie); new items wait in a shared pool; Clifford is the privacy owner.
- Services: server at netcup; uploaded files on the server's disk, backed up off the server; email through Mailjet (SMTP); Ubuntu 26.04; error tracking and uptime monitoring from EU-owned tools; Gotenberg turns agreement templates into PDFs.

## Open decisions

Konnected's legal entity and organisation number, how students are paid (employed per project or freelancer: the owner ticked both, check with the accountant), the second admin on each account, who gets alerts out of hours. Do not guess these. Ask.
