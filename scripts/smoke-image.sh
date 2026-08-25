#!/usr/bin/env bash
#
# Build the image and BOOT it. Run this before every deploy.
#
# This exists because of a real outage. A one-line Dockerfile change — adding `--omit=optional` to
# the runtime install — passed `docker build` cleanly, passed the whole 191-test suite, and then
# took production down: napi-style native packages ship their per-platform binary as an OPTIONAL
# dependency, so @node-rs/argon2 lost the thing it loads at require time, the server died on boot,
# and the machine restart-looped until Fly gave up.
#
# The lesson is narrow and worth encoding: building an image is not booting it, and the test suite
# runs against source, not against the artifact you ship. Nothing that existed before this script
# could have caught it. So: build the real image, run it against a real Postgres, and require a
# healthy answer from the same endpoint the platform's health check uses.
#
# Usage:  ./scripts/smoke-image.sh [--keep]
set -euo pipefail

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

TAG="datum:smoke-$$"
NET="datum-smoke-$$"
PG="datum-smoke-pg-$$"
APP="datum-smoke-app-$$"
PORT="${SMOKE_PORT:-8479}"

cleanup() {
  if (( KEEP == 0 )); then
    docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker rmi "$TAG" >/dev/null 2>&1 || true
  else
    echo "kept: container $APP on http://127.0.0.1:${PORT}, image $TAG"
  fi
}
trap cleanup EXIT

fail() { printf '\n\033[31mFAIL\033[0m  %s\n' "$1" >&2; exit 1; }
ok()   { printf '\033[32mok\033[0m    %s\n' "$1"; }

command -v docker >/dev/null || fail "docker is not on PATH"

echo "-- building the image the way a deploy would ----------------------------------"
docker build -t "$TAG" . >/dev/null || fail "docker build failed"
ok "image built"

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=datum postgres:18 >/dev/null
for _ in $(seq 1 90); do
  docker exec -u postgres "$PG" pg_isready -q -d datum && break
  sleep 1
done
docker exec -u postgres "$PG" pg_isready -q -d datum || fail "postgres never became ready"
ok "postgres up"

echo "-- booting the image ----------------------------------------------------------"
docker run -d --name "$APP" --network "$NET" \
  -e "DATABASE_URL=postgres://postgres:smoke@${PG}:5432/datum" \
  -e DATUM_ADMIN_PASSWORD=smoke-only \
  -e "DATUM_SESSION_SECRET=$(openssl rand -hex 32)" \
  -p "127.0.0.1:${PORT}:8080" "$TAG" >/dev/null

STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
  [[ "$STATUS" == "200" ]] && break
  # A container that has already exited will never become healthy; say so immediately rather
  # than burning the full timeout.
  if [[ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]]; then
    echo "--- container exited, last 40 lines ---"
    docker logs --tail 40 "$APP" 2>&1 || true
    fail "the image built but did not boot"
  fi
  sleep 1
done
[[ "$STATUS" == "200" ]] || { docker logs --tail 40 "$APP" 2>&1 || true; fail "/healthz never returned 200 (last: ${STATUS:-none})"; }
ok "/healthz 200 — migrations applied and the server is serving"

# The panel and the front door, because both have been broken by build changes before.
for path in / /admin/ /favicon.ico; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
  case "$path:$code" in
    "/:302"|"/admin/:200"|"/favicon.ico:200") ok "$path -> $code" ;;
    *) fail "$path returned $code" ;;
  esac
done

# The auth boundary, because an image that boots wide open is worse than one that does not boot.
for path in /v1/state /admin/api/keys; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
  [[ "$code" == "401" ]] || fail "$path returned $code, expected 401 — the image is not refusing anonymous callers"
  ok "$path -> 401"
done

printf '\n\033[32mPASS\033[0m  the image builds, boots, serves, and refuses anonymous callers\n'
