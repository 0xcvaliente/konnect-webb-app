# Shared by the scripts in scripts/deploy. Sourced, not run. Works with bash 3.2 (macOS) and 5.
#
# Settings (environment variables, all optional):
#   DEPLOY_DIR       folder with docker-compose.prod.yml (default: this repository's root)
#   ENV_FILE         settings file (default: $DEPLOY_DIR/.env.prod)
#   RELEASE_FILE     file with APP_IMAGE=... (default: $DEPLOY_DIR/release.env)
#   COMPOSE_PROJECT  Compose project name (default: konnected)
#   COMPOSE_FILES    Compose files, separated by ":" (default: docker-compose.prod.yml)

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.prod}"
RELEASE_FILE="${RELEASE_FILE:-$DEPLOY_DIR/release.env}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-konnected}"
COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.prod.yml}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}

[ -f "$ENV_FILE" ] || die "settings file not found: $ENV_FILE (copy .env.prod.example)"

# docker compose with this project's name, files and settings.
dc() {
  local args f
  args=(-p "$COMPOSE_PROJECT" --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE")
  if [ -f "$RELEASE_FILE" ]; then args+=(--env-file "$RELEASE_FILE"); fi
  local IFS=:
  for f in $COMPOSE_FILES; do
    case "$f" in /*) args+=(-f "$f") ;; *) args+=(-f "$DEPLOY_DIR/$f") ;; esac
  done
  unset IFS
  docker compose "${args[@]}" "$@"
}

# One value from the settings file, without loading the whole file into the environment.
setting() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# IDs of the running containers of one service.
service_containers() {
  docker ps -q \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=$1"
}

health_of() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"
}
