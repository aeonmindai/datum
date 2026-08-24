#!/usr/bin/env bash
#
# pg-machine-init.sh — stand up Datum's Postgres as our own Fly Machine, idempotently.
#
# Usage:
#   POSTGRES_PASSWORD='...' ./scripts/pg-machine-init.sh --org my-fly-org
#   POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')" ./scripts/pg-machine-init.sh --org my-fly-org
#
# Options:
#   --org NAME        Fly organisation to create the app in (required on first run)
#   --app NAME        database app name          (default: datum-db, or $DATUM_DB_APP)
#   --api-app NAME    API app to print the secret command for (default: datum)
#   --region CODE     region                     (default: sjc, or $DATUM_DB_REGION)
#   --volume NAME     volume name                (default: pgdata)
#   --size GB         volume size in GB          (default: 10)
#   --dry-run         print what would happen and change nothing
#
# Environment:
#   POSTGRES_PASSWORD  required. Supplied by you; set as a Fly secret and NEVER echoed by
#                      this script, not in logs, not in the summary, not on failure.
#
# Why our own Machine instead of Fly Managed Postgres: MPG is pinned to Postgres 16, lists
# version upgrades under what it does not yet do, and floors at $38/mo. A plain postgres:18
# image on a Machine with a volume gives any version at a fraction of that. The schema stays
# portable to Postgres 13 regardless, so the host remains a swappable decision.
#
# Run it as often as you like. Every step checks first: the app, the volume, the secret and
# the deploy are all no-ops when they are already in the desired state.

set -euo pipefail

APP="${DATUM_DB_APP:-datum-db}"
API_APP="${DATUM_API_APP:-datum}"
REGION="${DATUM_DB_REGION:-sjc}"
VOLUME="${DATUM_DB_VOLUME:-pgdata}"
SIZE_GB="${DATUM_DB_VOLUME_SIZE_GB:-10}"
ORG=""
DRY_RUN=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG="$REPO_ROOT/fly.postgres.toml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --org) ORG="${2:?--org needs a value}"; shift 2 ;;
    --app) APP="${2:?--app needs a value}"; shift 2 ;;
    --api-app) API_APP="${2:?--api-app needs a value}"; shift 2 ;;
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --volume) VOLUME="${2:?--volume needs a value}"; shift 2 ;;
    --size) SIZE_GB="${2:?--size needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "pg-machine-init.sh: unknown argument: $1" >&2; echo "try: $0 --help" >&2; exit 1 ;;
  esac
done

die() { echo "pg-machine-init.sh: FATAL: $*" >&2; exit 1; }
log() { echo "[pg-init] $*"; }
run() {
  if (( DRY_RUN == 1 )); then echo "[pg-init] DRY-RUN: $*"; return 0; fi
  "$@"
}

# ---- preconditions -----------------------------------------------------------------------
command -v fly >/dev/null 2>&1 \
  || die "'fly' is not on PATH. Install flyctl: https://fly.io/docs/flyctl/install/"
command -v jq >/dev/null 2>&1 \
  || die "'jq' is not on PATH. It is needed to read flyctl's JSON output (brew install jq / apt install jq)."

[[ -f "$CONFIG" ]] || die "config not found: $CONFIG"

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required.
  Generate one and keep it in your password manager:
    export POSTGRES_PASSWORD=\$(openssl rand -base64 24 | tr -d +/=)
  It is set as a Fly secret and is never printed by this script.}"

if (( ${#POSTGRES_PASSWORD} < 16 )); then
  die "POSTGRES_PASSWORD is shorter than 16 characters. This is the only credential in front
  of the store of record; make it long."
fi

fly auth whoami >/dev/null 2>&1 || die "not logged in to Fly. Run: fly auth login"

log "app=$APP  api-app=$API_APP  region=$REGION  volume=$VOLUME  size=${SIZE_GB}GB"

# ---- 1. the app --------------------------------------------------------------------------
if fly status -a "$APP" >/dev/null 2>&1; then
  log "app '$APP' already exists"
else
  [[ -n "$ORG" ]] || die "app '$APP' does not exist and no --org was given.
  Fly app names are globally unique; if '$APP' is taken by someone else, pass --app <name>."
  log "creating app '$APP' in org '$ORG'"
  run fly apps create --name "$APP" --org "$ORG"
fi

# ---- 2. the volume -----------------------------------------------------------------------
# One volume, one Machine. Volumes are single-region and unreplicated; that is accepted for
# v0 and is exactly why backup.sh exists.
volume_exists() {
  fly volumes list -a "$APP" --json 2>/dev/null \
    | jq -e --arg n "$VOLUME" 'any(.[]; .name == $n)' >/dev/null 2>&1
}

if volume_exists; then
  log "volume '$VOLUME' already exists in app '$APP'"
else
  log "creating volume '$VOLUME' (${SIZE_GB}GB, $REGION, encrypted, daily snapshots, 14d retention)"
  run fly volumes create "$VOLUME" \
    -a "$APP" \
    -r "$REGION" \
    -s "$SIZE_GB" \
    --snapshot-retention 14 \
    --scheduled-snapshots \
    --yes
fi

# ---- 3. the password ---------------------------------------------------------------------
# --stage so the secret is stored without triggering a deploy of an app that may not have a
# Machine yet; the deploy in step 4 picks it up. Note that this is a no-op-on-same-value
# operation as far as the running app is concerned, so re-running the script is safe, but it
# WILL rotate the value if you pass a different password — and Postgres only applies
# POSTGRES_PASSWORD at initdb time, so changing it here does not change the database. Rotate
# the real password with ALTER ROLE (see docs/OPERATIONS.md).
log "staging POSTGRES_PASSWORD as a Fly secret (value not printed)"
run fly secrets set -a "$APP" --stage "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" >/dev/null

# ---- 4. the Machine ----------------------------------------------------------------------
# --ha=false: exactly one Machine. Only one Machine can attach a volume, and v0 is explicitly
# a single writer with no HA — accept the restart window, add a replica when someone outside
# the org depends on it.
log "deploying $APP from $(basename "$CONFIG")"
run fly deploy -c "$CONFIG" -a "$APP" --ha=false

# ---- 5. readiness ------------------------------------------------------------------------
if (( DRY_RUN == 1 )); then
  log "DRY-RUN: skipping readiness wait"
else
  log "waiting for the TCP check on 5432 to pass..."
  READY=0
  # `fly checks list --json` returns an OBJECT KEYED BY MACHINE ID whose values are arrays of
  # checks, not a flat array. Indexing it as an array fails, which made this loop time out
  # while Postgres was in fact already passing — the worst kind of bug in a bootstrap script,
  # because it tells a first-time operator the database is broken when it is healthy.
  # `[.[][]]` flattens machine -> checks into one list before testing it.
  for _ in $(seq 1 60); do
    if fly checks list -a "$APP" --json 2>/dev/null \
       | jq -e '[.[][]] | length > 0 and all(.[]; (.status // .Status) == "passing")' >/dev/null 2>&1; then
      READY=1; break
    fi
    sleep 5
  done
  if (( READY == 1 )); then
    log "Postgres is passing its health check"
  else
    echo >&2
    echo "pg-machine-init.sh: the health check has not passed after 5 minutes." >&2
    echo "Look at the logs — initdb on a fresh volume can be slow, but a permission error on" >&2
    echo "PGDATA looks the same from out here:" >&2
    echo "  fly logs -a $APP" >&2
    exit 1
  fi
fi

# ---- 6. what to do next ------------------------------------------------------------------
# The password is never echoed. The command below is printed with the variable UNEXPANDED, so
# you can paste it while POSTGRES_PASSWORD is still set in your shell and the secret still
# never lands in your scrollback or your shell history file as a literal.
#
# sslmode: 6PN is an encrypted WireGuard mesh, and the stock postgres image serves no TLS
# certificate, so libpq's default sslmode=prefer correctly falls back to an unencrypted
# connection inside an already-encrypted tunnel. Do not append sslmode=require unless you
# have configured server certificates.
cat <<'NEXT'

------------------------------------------------------------------------------
Next: point the API app at it. Run this while POSTGRES_PASSWORD is still set —
it is deliberately printed unexpanded so the value stays out of your scrollback.
NEXT

printf '\n  fly secrets set -a %s DATABASE_URL="postgres://datum:$POSTGRES_PASSWORD@%s.internal:5432/datum"\n\n' \
  "$API_APP" "$APP"

cat <<NEXT
Then confirm the database is not publicly routable. This must print no addresses:

  fly ips list -a $APP

And the rest of the API app's secrets, by name only:

  fly secrets set -a $API_APP DATUM_ADMIN_PASSWORD_HASH='<datum hash-password ...>'
  fly secrets set -a $API_APP DATUM_SESSION_SECRET="\$(openssl rand -hex 32)"

Backups are not optional here — we are the database operator now. See
docs/OPERATIONS.md, then run ./scripts/restore-drill.sh and record the result.
------------------------------------------------------------------------------
NEXT
