#!/usr/bin/env bash
# Set up a local trial of the production stack on a laptop (docs/production.md).
#
#   scripts/deploy/local-trial.sh <folder outside the repository>
#
# Writes into the folder: trial.env (throwaway random secrets, SITE_ADDRESS=localhost), an SSH
# key pair for the backups and a host key for the stand-in SFTP server. Then prints the
# variables that point the deploy scripts at the trial (Compose project konnected-prodcheck,
# ports 8080/8443, the SFTP stand-in). Never use these files on the server.
set -euo pipefail

dir="${1:?usage: local-trial.sh <folder>}"
mkdir -p "$dir/ssh"
dir="$(cd "$dir" && pwd)"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
case "$dir/" in "$repo"/*) echo "use a folder outside the repository" >&2 && exit 1 ;; esac

[ -f "$dir/ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C konnected-trial -f "$dir/ssh/id_ed25519"
[ -f "$dir/sftp_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -C sftp-host -f "$dir/sftp_host_ed25519_key"
# The SFTP stand-in is reached as "sftp" on port 22.
printf 'sftp %s\n' "$(cut -d' ' -f1-2 "$dir/sftp_host_ed25519_key.pub")" >"$dir/ssh/known_hosts"
# Readable by PostgreSQL in its container (uid 999) on Linux hosts too. Throwaway key only: on
# the server the key stays private (docs/production.md).
chmod 644 "$dir/ssh/id_ed25519"

secret() { openssl rand -hex 32; }
if [ ! -f "$dir/trial.env" ]; then
  umask 077
  cat >"$dir/trial.env" <<EOF
# Local trial only. Throwaway values made by scripts/deploy/local-trial.sh.
SITE_ADDRESS=localhost
ACME_EMAIL=trial@example.com
APP_URL=https://localhost:8443
PAYLOAD_SECRET=$(secret)
ADMIN_EMAILS=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SMTP_HOST=
EMAIL_FROM=no-reply@example.com
POSTGRES_USER=konnected
POSTGRES_DB=konnected
POSTGRES_PASSWORD=$(secret)
BACKUP_SSH_DIR=$dir/ssh
SFTP_HOST_KEY=$dir/sftp_host_ed25519_key
BACKUP_SFTP_HOST=sftp
BACKUP_SFTP_PORT=22
BACKUP_SFTP_USER=konnected
PGBACKREST_REPO_PATH=/repo/pgbackrest
RESTIC_REPO_PATH=/repo/restic
PGBACKREST_CIPHER_PASS=$(secret)
RESTIC_PASSWORD=$(secret)
IMAGE_REPO=konnected-app
EOF
fi

cat <<EOF
Trial files are in $dir. Point the deploy scripts at the trial with:

  export ENV_FILE=$dir/trial.env RELEASE_FILE=$dir/release.env \\
    COMPOSE_PROJECT=konnected-prodcheck \\
    COMPOSE_FILES=docker-compose.prod.yml:docker-compose.prod.local.yml
EOF
