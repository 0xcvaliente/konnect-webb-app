#!/usr/bin/env bash
# Restore test: proves the off-server backups can be read and restored.
#
#   scripts/deploy/restore-test.sh
#
# 1. Counts the rows of every table in live, then commits a marker transaction there and runs
#    `pgbackrest check`, which switches to a new WAL segment and waits until the one holding the
#    marker is in the archive. Fails if archiving does not work.
# 2. Starts a throwaway PostgreSQL 18 container (the "restore-test" service, profile "tools") that
#    restores the newest pgBackRest backup from the Storage Box and replays the archived WAL up to
#    the marker, then opens the database. If a WAL segment between the backup and the marker is
#    missing, the marker is never reached and PostgreSQL refuses to open: the test fails. Nothing
#    is published; the container has no named volume and is removed at the end.
# 3. Compares the rows of every table with the live counts from step 1. Fails when the marker is
#    not in the restored database, a table is missing, a table has fewer rows than live had (more
#    than RESTORE_ROW_TOLERANCE fewer, default 5: rows deleted in the moment between counting and
#    the marker), every application table is empty, or the migrations differ.
# 4. Checks that the newest restic snapshot of the uploads holds every file the restored
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
tolerance="${RESTORE_ROW_TOLERANCE:-5}"
work="$(mktemp -d)"

cleanup() {
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
docker rm -f -v "$name" >/dev/null 2>&1 || true

started=$(date +%s)
live_psql() { dc exec -T postgres psql -X -q -U "$user" -d "$db" -At "$@"; }
restored_psql() { docker exec "$name" psql -X -q -U "$user" -d "$db" -At "$@"; }

# Row counts of every table in the public schema: "<table> <rows>" per line.
count_sql="SELECT c.relname || ' ' || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1"

live_psql -c "$count_sql" | sort >"$work/live"
[ -s "$work/live" ] || die "could not count the rows in the live database"

# The marker: a transaction of its own, committed right after the counts. Asking for its ID makes
# PostgreSQL write a commit record for it (no table is touched). Its full ID (with epoch) for
# pg_xact_status, and the 32-bit one for recovery_target_xid.
read -r marker_xid8 marker_xid < <(live_psql -c \
  "SELECT x || ' ' || (x::text::bigint % 4294967296) FROM (SELECT pg_current_xact_id() AS x) s") || true
[ -n "${marker_xid:-}" ] || die "could not write the marker transaction in the live database"
log "marker transaction $marker_xid8 committed in live; waiting until its WAL is archived"
dc exec -T -u postgres postgres pgbackrest --stanza=konnected --log-level-console=warn check ||
  die "WAL archiving does not work (pgbackrest check failed): fix that first"

log "restoring the newest backup into a throwaway container ($name), up to the marker"
# Not --rm: if PostgreSQL refuses to open, its log says why. cleanup removes the container.
dc --profile tools run -d --no-deps --name "$name" \
  -e PGBACKREST_TYPE=xid -e "PGBACKREST_TARGET=$marker_xid" -e PGBACKREST_TARGET_ACTION=promote \
  restore-test >/dev/null

waited=0
until [ "$(restored_psql -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ]; do
  if ! docker inspect "$name" >/dev/null 2>&1 || [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then
    # Only PostgreSQL's and pgBackRest's error lines (WAL file names and positions, no data).
    docker logs "$name" 2>&1 | grep -E 'FATAL|ERROR|unable to find' | tail -5 >&2 || true
    die "the restore container stopped. \"recovery ended before configured recovery target was reached\" means WAL between the backup and the marker is missing from the archive"
  fi
  [ "$waited" -lt "$timeout" ] || die "not restored after ${timeout}s"
  sleep 3
  waited=$((waited + 3))
done
log "restored and open after $(($(date +%s) - started))s"
log "last transaction replayed from the archive: $(restored_psql -c 'SELECT pg_last_xact_replay_timestamp()')"

failed=0
marker_status="$(restored_psql -c "SELECT pg_xact_status('$marker_xid8'::xid8)" 2>/dev/null || true)"
if [ "$marker_status" != committed ]; then
  log "FAIL: the marker transaction $marker_xid8 is not in the restored database (${marker_status:-unknown}): WAL is missing from the archive"
  failed=1
fi

restored_psql -c "$count_sql" | sort >"$work/restored"
[ -s "$work/restored" ] || die "the restored database has no tables"
printf '%-45s %10s %10s\n' table live restored
join -a 1 -e missing -o 0,1.2,2.2 "$work/live" "$work/restored" | while read -r table live restored; do
  note=""
  [ "$live" = "$restored" ] || note="  <- differs"
  printf '%-45s %10s %10s%s\n' "$table" "$live" "$restored" "$note"
done

short_tables=$(join -o 0,1.2,2.2 "$work/live" "$work/restored" |
  awk -v t="$tolerance" '$3 + t < $2 { print $1 }')
if [ -n "$short_tables" ]; then
  log "FAIL: fewer rows than live had (more than $tolerance fewer): $(echo "$short_tables" | tr '\n' ' ')"
  failed=1
fi
app_rows() { grep -v -E '^payload_migrations ' "$1" | awk '{ n += $2 } END { print n + 0 }'; }
if [ "$(app_rows "$work/live")" -gt 0 ] && [ "$(app_rows "$work/restored")" -eq 0 ]; then
  log "FAIL: every application table is empty in the restored database"
  failed=1
fi
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
