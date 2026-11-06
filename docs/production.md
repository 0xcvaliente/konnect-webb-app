# Production

How the app runs in production, how to try the whole production stack on a laptop, what the
netcup server still needs, and how backups and the restore test work.

Decided setup (6 Nov 2026, see the Engineering draft): one netcup VPS (Ubuntu 26.04 LTS), Docker
Compose, Caddy 2.11.7 in front, PostgreSQL 18 with continuous off-server backup by pgBackRest 2.60
to a Hetzner Storage Box over SFTP, restic for the uploads every 5 minutes, Gotenberg 8.38.1 for
DOCX to PDF, deploys without downtime. EU-owned suppliers only.

## The pieces

| File                             | What                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `Dockerfile`                     | The app image: Next.js standalone server, plus the Payload CLI in `/app/cli`               |
| `docker/postgres/Dockerfile`     | `postgres:18.6-trixie` plus pgBackRest 2.60                                                |
| `docker-compose.prod.yml`        | caddy, app, worker, postgres, gotenberg; one-off `migrate`, `restore-test`, `restic`       |
| `docker-compose.prod.local.yml`  | Local trial only: ports 8080/8443, an SFTP container instead of the Storage Box            |
| `caddy/Caddyfile`                | HTTPS and the reverse proxy to every running app container                                 |
| `.env.prod.example`              | Every production setting, placeholders only. The real `.env.prod` lives only on the server |
| `scripts/deploy/deploy.sh`       | Zero-downtime deploy of one image                                                          |
| `scripts/deploy/ROLLBACK.md`     | Going back to the previous image, and what that does not undo                              |
| `scripts/deploy/backup-db.sh`    | pgBackRest: set up, full, differential, incremental, check, info                           |
| `scripts/deploy/backup-media.sh` | restic for the uploads volume                                                              |
| `scripts/deploy/restore-test.sh` | Restores the newest backups into a throwaway container and compares                        |
| `scripts/deploy/pgbackrest/`     | pgBackRest settings (no secrets; server values come from `.env.prod`)                      |
| `scripts/deploy/crontab.example` | Backup schedule                                                                            |
| `scripts/deploy/local-trial.sh`  | Makes throwaway settings and keys for the local trial                                      |
| `.github/workflows/deploy.yml`   | On push to main: checks, then image to GHCR tagged with the commit SHA. Server step is off |
| `src/app/api/health/route.ts`    | `/api/health`: `{"status":"ok"}` or `503 {"status":"unavailable"}` (runs `SELECT 1`)       |

### The containers

- **caddy** is the only container with published ports (80, 443, 443/udp). Certificates from
  Let's Encrypt for `SITE_ADDRESS`. No access log (request lines carry sign-in tokens).
- **app** runs `node server.js` as the non-root `node` user. No `container_name` and no published
  port, so a second copy can run next to it during a deploy; Caddy finds every copy through
  Docker's DNS (`dynamic a app 3000`, refreshed every second) and retries a request on another copy
  for up to 30 s when one cannot be reached. Health: `/api/health` every 10 s. Docker's DNS lists a
  container whether it is healthy or not, and Caddy cannot health-check dynamic upstreams, so
  `deploy.sh` keeps a new copy off the `public` network until its health check passes.
- **worker** is the same image running `payload jobs:run --cron "* * * * *" --all-queues
--handle-schedules` in `/app/cli`, with `TZ=Europe/Oslo` so the 03:15 file clean-up is Norwegian
  time. The app itself runs no jobs in production (`RUN_JOBS_IN_APP=false`), because two app
  containers run side by side during a deploy. Exactly one worker.
- **migrate** (one-off) runs `payload migrate` from the new image before the swap.
- **postgres** has no published port. `archive_mode=on`, `archive_timeout=60`: every finished WAL
  segment, at least one a minute, goes to the Storage Box through `pgbackrest archive-push`.
- **gotenberg** is on the internal network only (no internet, no ports), with a 1 GB memory limit,
  Chromium routes, downloads and webhooks switched off. Only LibreOffice (DOCX to PDF) is used.

Networks: `public` (caddy, app), `internal` (internal-only: app, worker, migrate, postgres,
gotenberg), `outbound` (postgres, worker, restic, restore-test; outgoing only: Storage Box,
email). Volumes: `pgdata`,
`media` (uploads, `/data/media`), `caddy_data`, `caddy_config`, `restic_cache`.

Each service gets only its own settings: `.env.prod` is read by Compose to fill in `${...}` in
the Compose file, never passed whole to a container. The image holds no secrets and is built
without build arguments.

## Try it on this laptop

Needs Docker running. Uses the Compose project name `konnected-prodcheck`, so it never touches
the development stack (`docker-compose.yml`). PostgreSQL is not published; Caddy listens on
`127.0.0.1:8080` and `127.0.0.1:8443`.

```bash
# 1. Images
docker build -t konnected-app:v1 .

# 2. Throwaway settings and keys, outside the repository
scripts/deploy/local-trial.sh ../konnected-trial
export ENV_FILE=$PWD/../konnected-trial/trial.env RELEASE_FILE=$PWD/../konnected-trial/release.env \
  COMPOSE_PROJECT=konnected-prodcheck \
  COMPOSE_FILES=docker-compose.prod.yml:docker-compose.prod.local.yml

# 3. Backups first (deploy.sh takes a backup before migrating)
printf 'APP_IMAGE=konnected-app:v1\n' > "$RELEASE_FILE"
docker compose -p konnected-prodcheck --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml build postgres
docker compose -p konnected-prodcheck --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml up -d --wait sftp postgres
scripts/deploy/backup-db.sh setup
scripts/deploy/backup-media.sh init

# 4. Deploy
scripts/deploy/deploy.sh konnected-app:v1
curl -k https://localhost:8443/api/health           # {"status":"ok"}
open https://localhost:8443/en                      # accept Caddy's local certificate
```

`docker compose -f docker-compose.prod.yml up` alone also works once `.env.prod` and `release.env`
are passed with `--env-file`, but `deploy.sh` is the way the server does it.

Zero-downtime check: tag the same image again (`docker tag konnected-app:v1 konnected-app:v2`),
run a loop of `curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/en` in another
terminal, and run `scripts/deploy/deploy.sh konnected-app:v2`. No request should fail.

Restore check: `scripts/deploy/backup-db.sh diff`, `scripts/deploy/backup-media.sh backup`, then
`scripts/deploy/restore-test.sh`.

Clean up (this project only, never the development project):

```bash
docker compose -p konnected-prodcheck --env-file "$ENV_FILE" --env-file "$RELEASE_FILE" \
  -f docker-compose.prod.yml -f docker-compose.prod.local.yml --profile tools down --volumes --remove-orphans
rm -rf ../konnected-trial
```

### Tried on 6 Nov 2026 (Apple silicon, Docker 29.8, Compose 5.5)

- Image built without a database or secrets (1.25 GB: the standalone server is about 75 MB, the
  CLI's production `node_modules` the rest). The Payload CLI works inside it: `migrate`,
  `migrate:status`, `jobs:run`, and `run src/seed.ts` (trial data only).
- The standalone output holds only `server.js`, `.next`, `node_modules` and `package.json`. Before
  the `turbopackIgnore` comments in `src/lib/uploads/storage.ts`, the build tracer copied the
  whole project into it, including `./media` (uploads) on a developer machine.
- `https://localhost:8443/en` and `/no` render; `/api/health` answers `{"status":"ok"}` with
  `Cache-Control: no-store`, and no `Server` or `Via` header. A seeded student signed in and
  downloaded their CV from the media volume; anonymous download gets 403.
- Worker queued the clean-up for 03:15 Oslo time (02:15 UTC) and ran it when made due.
- Swaps under three parallel request loops (GET `/api/health`, `/en`, `/no`, POST
  `/api/health`): v1 to v2, 2928 requests, 0 failed; v2 to v3, 2472 requests, 0 failed. A broken
  image (never healthy) was removed after the timeout and the old container kept serving: 2496
  requests, 0 failed.
- 7 Nov, small stand-in images: an image that starts and listens but answers 503 on `/api/health`
  and 500 on pages. Before the fix the new container got traffic while it was still unhealthy:
  1227 of 2877 requests to `/en` failed during the 40 s health timeout. With the new container
  kept off `public` until healthy: 2802 requests, 0 failed, and it was removed. Healthy swaps after
  the fix: 991 and 996 requests, 0 failed.
- pgBackRest against the SFTP stand-in: stanza created, WAL archived, full, diff and incremental
  backups. Restore test: a row written after the last backup came back through WAL replay; every
  table matched live; the CV file referenced by the database was in the newest restic snapshot.
  Restore and open took 13 s.

## The netcup server (later)

Not done yet; this is the list for when the server is ordered.

1. **Server**: Ubuntu 26.04 LTS, timezone Europe/Oslo. Non-root `deploy` user with SSH keys only,
   no root login, no passwords, fail2ban, unattended security upgrades. Firewall: 22, 80, 443
   (TCP) and 443/udp; netcup's own firewall too if offered. Docker published ports bypass UFW, so
   only Caddy publishes any.
2. **Docker** from Docker's apt repository (not Ubuntu's `docker.io`). Log rotation is set per
   service in the Compose file.
3. **Files**: a checkout of this repository in `/opt/konnected` (the deploy job moves it to the
   commit it deploys), `.env.prod` from `.env.prod.example` (mode 600), `release.env` is written by
   `deploy.sh`.
4. **Backup keys**: `ssh-keygen -t ed25519 -N '' -f /opt/konnected/backup-ssh/id_ed25519`, add the
   public key to the Storage Box (SFTP/SSH on port 23), and pin its host key:
   `ssh-keyscan -p 23 uXXXXXX.your-storagebox.de > backup-ssh/known_hosts`. Then
   `sudo chown -R 999:999 backup-ssh && sudo chmod 600 backup-ssh/id_ed25519`: PostgreSQL in its
   container runs as uid 999; restic takes a private copy of the key. Put
   `PGBACKREST_CIPHER_PASS` and `RESTIC_PASSWORD` in the password manager as well.
5. **Storage Box paths**: check the absolute folder layout after the first SFTP login and set
   `PGBACKREST_REPO_PATH` and `RESTIC_REPO_PATH` (the example values `/home/...` are not
   verified).
6. **Image pulls**: the GHCR package is private by default. Either a classic personal access token
   with only `read:packages` (`docker login ghcr.io`), ideally from a bot account, or make the
   package public (it holds no secrets).
7. **First start**: `docker compose ... build postgres`, `up -d --wait postgres`,
   `scripts/deploy/backup-db.sh setup`, `scripts/deploy/backup-media.sh init`, then
   `scripts/deploy/deploy.sh <sha>`. Install `scripts/deploy/crontab.example`. Run
   `scripts/deploy/restore-test.sh` and write down the time it took.
8. **GitHub**: the `production` environment with `DEPLOY_HOST`, `DEPLOY_SSH_KEY` and
   `DEPLOY_HOST_FINGERPRINT`; restrict the deploy key on the server with a forced command; then
   switch the deploy job on (`if: false` in `.github/workflows/deploy.yml`).
9. **Monitoring**: UptimeRobot on `https://<app>/api/health`; alert when a backup or the restore
   test does not run (cron exit codes); Bugsink for errors. Not part of this change.

## Deploys

`scripts/deploy/deploy.sh <sha>`: pull the image, incremental backup, migrations in a one-off
container, a second app container next to the old one but off Caddy's network, wait for its
health check, put it on Caddy's network, stop the old one (Next.js finishes the requests it
started), restart the worker. If anything fails before the
swap, the old container keeps serving. Migrations must be backward compatible (expand, then
contract), because the old app runs on the new schema during the swap and after a rollback. See
`scripts/deploy/ROLLBACK.md`.

Server Actions: every build has its own Server Action IDs, so a form in a tab opened before a
deploy may fail once and work after a reload. This is how Next.js behaves when self-hosted. A fixed
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` and `deploymentId` would soften it, but the key is a secret
and must not be a build argument, so it is left open.

## Backups

- **Database**: WAL archived continuously (at most about a minute of changes at risk), full backup
  on Sundays, differential on other nights, incremental before every deploy. Encrypted
  (`aes-256-cbc`) before it leaves the server. Kept 14 days (`repo1-retention-full-type=time`),
  the period in the privacy policy: change both together or neither.
- **Uploads**: restic snapshot of the `media` volume every 5 minutes, encrypted, kept 14 days.
- **Restore test**: `scripts/deploy/restore-test.sh` counts the rows of every table in live,
  commits a marker transaction and waits until its WAL is archived (`pgbackrest check`). Then it
  restores the newest database backup into a throwaway PostgreSQL 18 container (no published port,
  no named volume) and replays the archived WAL up to that marker. It fails when the marker cannot
  be reached (a gap in the archived WAL), when a table is missing or has fewer rows than live had
  (more than `RESTORE_ROW_TOLERANCE`, default 5), when every application table is empty, or when
  the migrations differ. It also checks every upload in the restored database is in the newest
  restic snapshot. Prints table names and counts only. Monthly from cron, and by
  hand after any change to the backup setup. A restore test counts when it passes on a clean
  machine too; once agreements exist, add a signed PDF whose SHA-256 still matches.
- **If WAL cannot be archived** (Storage Box down) WAL piles up on the server disk. Above 4 GiB
  pgBackRest drops it so PostgreSQL keeps running; point-in-time restore then has a gap until the
  next full backup. Watch for archive errors in the PostgreSQL log.
