#!/usr/bin/env bash
# Upload backups (CVs, brief files, deliverables, logos; the "media" volume) with restic to the
# Storage Box over SFTP. Encrypted by restic before it leaves the server.
#
#   scripts/deploy/backup-media.sh init       once: create the restic repository
#   scripts/deploy/backup-media.sh backup     new snapshot (cron: every 5 minutes; quick when
#                                             nothing changed)
#   scripts/deploy/backup-media.sh prune      forget snapshots older than 14 days, then check
#                                             (cron: nightly)
#   scripts/deploy/backup-media.sh snapshots  list snapshots
#   scripts/deploy/backup-media.sh ls         files in the newest snapshot
#
# Runs restic in a one-off container (the "restic" service, profile "tools") that mounts the
# media volume read-only. 14 days matches the database backups and the privacy policy.
source "$(dirname "$0")/lib.sh"

restic() { dc run --rm -T --no-deps restic "$@"; }

# Never two at once (a slow upload must not pile up behind the 5-minute cron).
lock="$DEPLOY_DIR/.backup-media.lock"
if ! mkdir "$lock" 2>/dev/null; then
  log "another media backup is running; skipping"
  exit 0
fi
trap 'rmdir "$lock" 2>/dev/null || true' EXIT

case "${1:-}" in
  init) restic init ;;
  backup) restic backup --tag media --one-file-system /data/media ;;
  prune)
    restic forget --tag media --keep-within 14d --prune
    restic check
    ;;
  snapshots) restic snapshots ;;
  ls) restic ls latest ;;
  *)
    echo "usage: $0 init|backup|prune|snapshots|ls" >&2
    exit 2
    ;;
esac
