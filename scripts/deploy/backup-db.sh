#!/usr/bin/env bash
# Database backups with pgBackRest, run inside the postgres container (as the postgres user).
#
#   scripts/deploy/backup-db.sh setup     once: create the stanza on the Storage Box and check
#                                         that WAL archiving works
#   scripts/deploy/backup-db.sh full      full backup (cron: Sundays)
#   scripts/deploy/backup-db.sh diff      differential backup (cron: other days)
#   scripts/deploy/backup-db.sh incr      incremental backup (deploy.sh, before migrations)
#   scripts/deploy/backup-db.sh check     is archiving working?
#   scripts/deploy/backup-db.sh info      list the backups in the repository
#
# Backups older than 14 days are expired after every backup (scripts/deploy/pgbackrest/pgbackrest.conf).
source "$(dirname "$0")/lib.sh"

pgbr() { dc exec -T -u postgres postgres pgbackrest --stanza=konnected "$@"; }

case "${1:-}" in
  setup)
    pgbr stanza-create
    pgbr check
    ;;
  full | diff | incr) pgbr --type="$1" backup ;;
  check) pgbr check ;;
  info) pgbr info ;;
  *)
    echo "usage: $0 setup|full|diff|incr|check|info" >&2
    exit 2
    ;;
esac
