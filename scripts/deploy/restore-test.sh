#!/usr/bin/env bash
# Restore test: proves the off-server backups can be read and restored.
#
#   scripts/deploy/restore-test.sh
#
# 1. Starts a throwaway PostgreSQL 18 container (the "restore-test" service, profile "tools") that
#    restores the newest pgBackRest backup from the Storage Box, replays every archived WAL
#    segment after it, and opens the database. Nothing is published; the container has no named
#    volume and is removed at the end.
# 2. Counts the rows of every table, there and in the live database, side by side. Fails when a
#    table is missing, the restored database is empty, or the migrations differ. The restored copy
#    may be a little behind live (changes since the last archived WAL segment, about a minute).
# 3. Checks that the newest restic snapshot of the uploads holds every file the restored
#    database points to (skip with SKIP_MEDIA=1).
#
# Prints table names and counts only, never row contents. Run it monthly and after any change to
# the backup setup; record the result and the time it took in the runbook.
source "$(dirname "$0")/lib.sh"
# sort, join and comm must agree on the order.
export LC_ALL=C

db="$(setting POSTGRES_DB)"
user="$(setting POSTGRES_USER)"
[ -n "$db" ] && [ -n "$user" ] || die "POSTGRES_DB and POSTGRES_USER must be set in $ENV_FILE"
name="${COMPOSE_PROJECT}-restore-test"
timeout="${RESTORE_TIMEOUT:-1800}"
work="$(mktemp -d)"

cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
docker rm -f -v "$name" >/dev/null 2>&1 || true

started=$(date +%s)
log "restoring the newest backup into a throwaway container ($name)"
dc --profile tools run -d --rm --no-deps --name "$name" restore-test >/dev/null

restored_psql() { docker exec "$name" psql -X -q -U "$user" -d "$db" -At "$@"; }

waited=0
until [ "$(restored_psql -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ]; do
  if ! docker inspect "$name" >/dev/null 2>&1 || [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    die "the restore container stopped (pgBackRest or PostgreSQL failed; run it by hand to see why)"
  fi
  [ "$waited" -lt "$timeout" ] || die "not restored after ${timeout}s"
  sleep 3
  waited=$((waited + 3))
done
log "restored and open after $(($(date +%s) - started))s"
log "last transaction replayed from the archive: $(restored_psql -c 'SELECT pg_last_xact_replay_timestamp()')"

# Row counts of every table in the public schema: "<table> <rows>" per line.
count_sql="SELECT c.relname || ' ' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1"

restored_psql -c "$count_sql" | sort >"$work/restored"
dc exec -T postgres psql -X -q -U "$user" -d "$db" -At -c "$count_sql" | sort >"$work/live"

[ -s "$work/restored" ] || die "the restored database has no tables"
printf '%-45s %10s %10s\n' table live restored
join -a 1 -e missing -o 0,1.2,2.2 "$work/live" "$work/restored" | while read -r table live restored; do
  note=""
  [ "$live" = "$restored" ] || note="  <- differs"
  printf '%-45s %10s %10s%s\n' "$table" "$live" "$restored" "$note"
done

failed=0
missing_tables=$(join -v 1 "$work/live" "$work/restored" | cut -d' ' -f1)
if [ -n "$missing_tables" ]; then
  log "FAIL: tables missing in the restored database: $(echo "$missing_tables" | tr '\n' ' ')"
  failed=1
fi
live_migrations=$(grep -E '^payload_migrations ' "$work/live" | cut -d' ' -f2)
restored_migrations=$(grep -E '^payload_migrations ' "$work/restored" | cut -d' ' -f2)
if [ -z "$restored_migrations" ] || [ "$restored_migrations" = 0 ] || [ "$live_migrations" != "$restored_migrations" ]; then
  log "FAIL: migrations differ (live ${live_migrations:-none}, restored ${restored_migrations:-none})"
  failed=1
fi

if [ "${SKIP_MEDIA:-0}" != 1 ]; then
  # Every stored upload the restored database knows, as "<collection folder>/<file name>".
  # Stored file names are random, so this list holds no personal data.
  restored_psql -c "
    SELECT 'cvs/' || filename FROM cvs WHERE filename IS NOT NULL
    UNION ALL SELECT 'brief-files/' || filename FROM brief_files WHERE filename IS NOT NULL
    UNION ALL SELECT 'deliverable-files/' || filename FROM deliverable_files WHERE filename IS NOT NULL
    UNION ALL SELECT 'company-logos/' || filename FROM company_logos WHERE filename IS NOT NULL" |
    sort >"$work/files-expected"
  dc run --rm -T --no-deps restic ls latest | sed -n 's#^/data/media/##p' | sort >"$work/files-snapshot"
  missing_files=$(comm -23 "$work/files-expected" "$work/files-snapshot" | wc -l | tr -d ' ')
  log "uploads: $(wc -l <"$work/files-expected" | tr -d ' ') in the restored database, $missing_files missing from the newest restic snapshot"
  if [ "$missing_files" != 0 ]; then
    comm -23 "$work/files-expected" "$work/files-snapshot" | head -20 >&2
    log "FAIL: uploads missing (a file uploaded in the last 5 minutes may not be in a snapshot yet; run again)"
    failed=1
  fi
fi

[ "$failed" = 0 ] || exit 1
log "restore test passed in $(($(date +%s) - started))s"
