#!/usr/bin/env bash
# Deploy one app image without downtime.
#
#   scripts/deploy/deploy.sh <commit-sha | image-reference>
#
# 1. Pulls the image (a bare SHA means $IMAGE_REPO:<sha> from the settings file).
# 2. Takes an incremental pgBackRest backup (skip with SKIP_BACKUP=1, for the very first deploy).
# 3. Runs the migrations once, in a one-off container of the new image. They must be backward
#    compatible (expand, then contract in a later release): the old app keeps serving on the new
#    schema until step 5. A failing migration stops the deploy; the old app keeps running.
#    SKIP_MIGRATIONS=1 skips this step (rollback to an older image, see ROLLBACK.md).
# 4. Creates a second app container from the new image and takes it off the "public" network
#    before it starts, so Caddy (which sends traffic to every container named "app" there,
#    whatever its health) cannot reach it. Waits until its Docker health check (/api/health)
#    passes, and only then puts it on "public" as "app". If it never passes, the new container
#    is removed and the old one keeps serving: no user request ever reached the new one.
# 5. Stops the old container. Next.js finishes the requests it started; Caddy sends new requests
#    to the new container and retries any that hit the old one while it closes.
# 6. Restarts the worker on the new image and records the image in release.env.
#
# Settings: see lib.sh. Also HEALTH_TIMEOUT (seconds, default 180) and DRAIN_SECONDS (default 5:
# time for Caddy to see the new container before the old one stops).
source "$(dirname "$0")/lib.sh"

target="${1:?usage: deploy.sh <commit-sha | image-reference>}"
case "$target" in
  */* | *:* | *@*) image="$target" ;;
  *)
    repo="$(setting IMAGE_REPO)"
    [ -n "$repo" ] || die "IMAGE_REPO is not set in $ENV_FILE; pass a full image reference"
    image="$repo:$target"
    ;;
esac
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
DRAIN_SECONDS="${DRAIN_SECONDS:-5}"

# One deploy at a time.
lock="$DEPLOY_DIR/.deploy.lock"
mkdir "$lock" 2>/dev/null || die "another deploy is running (remove $lock if it is not)"
release_file="$RELEASE_FILE"
next_release="$release_file.next"
new_ids=""
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$new_ids" ]; then
    log "removing the new app container; the old one keeps serving"
    # shellcheck disable=SC2086
    docker rm -f $new_ids >/dev/null 2>&1 || true
  fi
  rm -f "$next_release"
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

log "deploying $image"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker pull "$image"
fi
printf 'APP_IMAGE=%s\n' "$image" >"$next_release"
RELEASE_FILE="$next_release"

# PostgreSQL and Gotenberg are left alone if they already run.
dc up -d --wait --no-recreate postgres gotenberg

if [ "${SKIP_BACKUP:-0}" != 1 ]; then
  log "backup before migrations (pgBackRest, incremental)"
  dc exec -T -u postgres postgres pgbackrest --stanza=konnected --type=incr backup
fi

if [ "${SKIP_MIGRATIONS:-0}" != 1 ]; then
  log "migrations"
  dc run --rm migrate
fi

old_ids="$(service_containers app | tr '\n' ' ')"
old_count=$(echo "$old_ids" | wc -w | tr -d ' ')

if [ "$old_count" -eq 0 ]; then
  log "no app running: starting the first one"
  dc up -d --no-deps --wait --wait-timeout "$HEALTH_TIMEOUT" app
else
  # A stopped or never started app container left by an interrupted run would count towards
  # --scale below. It serves nothing: remove it.
  stale="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=app" --filter status=created --filter status=exited)"
  # shellcheck disable=SC2086
  [ -z "$stale" ] || docker rm -f $stale >/dev/null

  log "creating a new app container next to the $old_count running"
  dc up -d --no-deps --no-recreate --no-start --scale "app=$((old_count + 1))" app
  new_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=app" --filter status=created | tr '\n' ' ')"
  [ -n "${new_ids// /}" ] || die "no new app container was created"

  # Caddy finds app containers by the name "app" on the "public" network (caddy/Caddyfile).
  # Docker's DNS answers with every running container there, healthy or not, so the new one stays
  # off that network until its health check passes. Its health check, the database and
  # everything else it needs at start-up are on "internal".
  public_net="${COMPOSE_PROJECT}_public"
  for id in $new_ids; do
    docker network disconnect "$public_net" "$id"
    docker start "$id" >/dev/null
  done

  for id in $new_ids; do
    waited=0
    while :; do
      state="$(health_of "$id")"
      [ "$state" = healthy ] && break
      if [ "$state" = unhealthy ] || [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
        # The health check's own output is {"status":...} only: safe to show.
        docker inspect -f '{{range .State.Health.Log}}{{.ExitCode}} {{.Output}}{{end}}' "$id" >&2 || true
        die "new app container is $state after ${waited}s"
      fi
      sleep 2
      waited=$((waited + 2))
    done
    log "new app container ${id} is healthy after ${waited}s: giving it traffic"
    docker network connect --alias app "$public_net" "$id"
  done

  # Caddy re-reads the app addresses every second.
  sleep "$DRAIN_SECONDS"
  for id in $old_ids; do
    log "stopping old app container $id"
    docker stop -t 30 "$id" >/dev/null
    docker rm "$id" >/dev/null
  done
  new_ids=""
fi

dc up -d --no-deps worker
dc up -d --no-deps --no-recreate caddy

if [ -f "$release_file" ]; then cp "$release_file" "$release_file.previous"; fi
mv "$next_release" "$release_file"
log "done: $image"
