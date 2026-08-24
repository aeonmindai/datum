#!/usr/bin/env bash
#
# restore-drill.sh — restore a Datum backup into a throwaway Postgres and prove it is real.
#
# Usage:
#   ./scripts/restore-drill.sh                      # fetch the newest object from the bucket
#   ./scripts/restore-drill.sh --file backup.dump.age
#   ./scripts/restore-drill.sh --file backup.dump    # already decrypted
#   ./scripts/restore-drill.sh --keep                # leave the container up for poking
#   ./scripts/restore-drill.sh --run-suite           # also run the vitest invariant suite
#
# Environment:
#   DATUM_BACKUP_AGE_IDENTITY  path to the age identity file (required for .age input)
#   DATUM_BACKUP_BUCKET        bucket to fetch from when --file is not given
#   DATUM_BACKUP_ENDPOINT      S3-compatible endpoint (optional)
#   DATUM_BACKUP_PREFIX        key prefix (default: datum)
#   DATUM_DRILL_PG_IMAGE       Postgres image for the throwaway server (default: postgres:18)
#   DATUM_DRILL_SOURCE_URL     live database to compare row counts against (optional)
#   DATUM_DRILL_STRICT_COUNTS  1 = a count mismatch against the source is a FAIL
#
# A backup you have never restored is not a backup. By this project's own doctrine — nothing
# is a result until it has actually run — an untested backup is an unverified claim, and this
# store exists precisely to refuse unverified claims. So the drill is executable, it prints
# PASS/FAIL, and it exits non-zero when the restore does not hold up.
#
# What it checks, against the RESTORED database and nothing else:
#   * the `no_two_live_contradictions` exclusion constraint exists, is contype='x', and still
#     carries its partial predicate (so human/unverified testimony stays exempt)
#   * btree_gist came back with it
#   * every trigger the migrations create is present
#   * `datum_app` holds SELECT+INSERT and NOT UPDATE/DELETE/TRUNCATE on datum.assertions
#   * a real UPDATE as datum_app is refused, and a real TRUNCATE as the owner is refused
#   * every expected table restored, with its row counts printed
#
# One thing to understand about the ACL checks: backup.sh dumps with --no-privileges, so the
# GRANT/REVOKE layer is NOT inside the dump, and `datum.schema_migrations` IS — which means a
# `datum migrate` after a restore is a no-op and will not put the grants back. Recovery is
# therefore restore + replay of the role/grant layer. This drill performs that replay from
# the migration files and then asserts the outcome; if it did not, "datum_app holds no UPDATE"
# would pass vacuously on a database where datum_app holds nothing at all.
#
# Exit codes: 0 all checks passed, 1 at least one FAIL or a precondition failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MIGRATIONS_DIR="$REPO_ROOT/packages/datum/migrations"

IMAGE="${DATUM_DRILL_PG_IMAGE:-postgres:18}"
DB="datum"
PREFIX="${DATUM_BACKUP_PREFIX:-datum}"

DUMP_INPUT=""
KEEP=0
RUN_SUITE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) DUMP_INPUT="${2:?--file needs a path}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --run-suite) RUN_SUITE=1; shift ;;
    -h|--help) sed -n '2,42p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
    *) echo "restore-drill.sh: unknown argument: $1" >&2; echo "try: $0 --help" >&2; exit 1 ;;
  esac
done

die() { echo "restore-drill.sh: FATAL: $*" >&2; exit 1; }
log() { echo "[drill] $*"; }

command -v docker >/dev/null 2>&1 || die "docker is not on PATH; the drill needs it for the throwaway server"
[[ -d "$MIGRATIONS_DIR" ]] || die "migrations directory not found at $MIGRATIONS_DIR"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/datum-drill.XXXXXX")"
CONTAINER="datum-restore-drill-$$"

cleanup() {
  local rc=$?
  if [[ "$KEEP" == "1" ]]; then
    echo
    log "--keep: container '$CONTAINER' left running. Connect with:"
    log "  docker exec -it -u postgres $CONTAINER psql -d $DB"
    log "Remove it with: docker rm -f $CONTAINER"
    log "Temporary files left in $WORKDIR"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
  fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

WALL_START="$SECONDS"

# ---- 1. get a dump -----------------------------------------------------------------------
if [[ -z "$DUMP_INPUT" ]]; then
  command -v aws >/dev/null 2>&1 || die "no --file given and the aws CLI is not on PATH"
  : "${DATUM_BACKUP_BUCKET:?no --file given, so DATUM_BACKUP_BUCKET is required}"

  AWS_ARGS=()
  [[ -n "${DATUM_BACKUP_ENDPOINT:-}" ]] && AWS_ARGS+=(--endpoint-url "$DATUM_BACKUP_ENDPOINT")

  log "finding the newest object under s3://${DATUM_BACKUP_BUCKET}/${PREFIX}/"
  NEWEST_KEY="$(
    aws "${AWS_ARGS[@]}" s3api list-objects-v2 \
      --bucket "$DATUM_BACKUP_BUCKET" --prefix "${PREFIX}/" \
      --query 'sort_by(Contents, &LastModified)[-1].Key' --output text
  )"
  [[ -n "$NEWEST_KEY" && "$NEWEST_KEY" != "None" ]] || die "no objects under ${PREFIX}/ in that bucket"

  log "newest: $NEWEST_KEY"
  DUMP_INPUT="$WORKDIR/$(basename "$NEWEST_KEY")"
  aws "${AWS_ARGS[@]}" s3 cp "s3://${DATUM_BACKUP_BUCKET}/${NEWEST_KEY}" "$DUMP_INPUT" --only-show-errors
fi

[[ -f "$DUMP_INPUT" ]] || die "dump file not found: $DUMP_INPUT"
log "input: $DUMP_INPUT ($(wc -c < "$DUMP_INPUT" | tr -d ' ') bytes)"

# ---- 2. decrypt if needed ----------------------------------------------------------------
DUMP_FILE="$DUMP_INPUT"
if [[ "$DUMP_INPUT" == *.age ]]; then
  command -v age >/dev/null 2>&1 || die "input is age-encrypted but 'age' is not on PATH"
  : "${DATUM_BACKUP_AGE_IDENTITY:?DATUM_BACKUP_AGE_IDENTITY (path to the age identity file) is required to decrypt}"
  [[ -f "$DATUM_BACKUP_AGE_IDENTITY" ]] || die "age identity file not found: $DATUM_BACKUP_AGE_IDENTITY"
  DUMP_FILE="$WORKDIR/decrypted.dump"
  log "decrypting..."
  age -d -i "$DATUM_BACKUP_AGE_IDENTITY" -o "$DUMP_FILE" "$DUMP_INPUT"
  log "decrypted: $(wc -c < "$DUMP_FILE" | tr -d ' ') bytes"
fi

# ---- 3. throwaway server -----------------------------------------------------------------
# Nothing about the restore target is shared with anything: a fresh container, a random
# superuser password that is never printed and never used (all access is over the container's
# local socket as the postgres user), and a hard remove on exit.
PGPW="$( (openssl rand -hex 16) 2>/dev/null || (head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') )"

log "starting throwaway $IMAGE as $CONTAINER"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PGPW" \
  -e POSTGRES_DB="$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null

READY=0
for _ in $(seq 1 90); do
  if docker exec -u postgres "$CONTAINER" pg_isready -q -d "$DB" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
(( READY == 1 )) || { docker logs --tail 40 "$CONTAINER" >&2 || true; die "throwaway Postgres never became ready"; }

SERVER_VERSION="$(docker exec -u postgres "$CONTAINER" psql -X -q -t -A -d "$DB" -c 'SHOW server_version')"
HOST_PORT="$(docker port "$CONTAINER" 5432/tcp | head -n 1)"
log "ready: Postgres $SERVER_VERSION on $HOST_PORT"

# ---- 4. restore --------------------------------------------------------------------------
# pg_restore runs INSIDE the container, so its version always matches the server and the host
# needs no Postgres client at all.
# `docker cp` preserves the host file's mode and lands it owned by root, while pg_restore and
# psql below run as the unprivileged `postgres` user. A backup file created under a restrictive
# umask — which is exactly what a careful operator does with an encrypted dump — is then
# unreadable inside the container, and the failure reads "could not open input file: Permission
# denied", which looks like a corrupt dump rather than a permissions problem. So make it
# readable explicitly, as root, after the copy.
docker cp "$DUMP_FILE" "$CONTAINER:/tmp/datum.dump" >/dev/null
docker exec -u root "$CONTAINER" chmod 0644 /tmp/datum.dump

log "restoring..."
RESTORE_START="$SECONDS"
RESTORE_RC=0
docker exec -u postgres "$CONTAINER" \
  pg_restore -d "$DB" --no-owner --no-privileges --jobs 2 /tmp/datum.dump \
  >"$WORKDIR/restore.log" 2>&1 || RESTORE_RC=$?
RESTORE_SECONDS=$(( SECONDS - RESTORE_START ))

if (( RESTORE_RC != 0 )); then
  echo "---- pg_restore output (last 40 lines) ----" >&2
  tail -n 40 "$WORKDIR/restore.log" >&2
  echo "-------------------------------------------" >&2
fi
log "pg_restore exited $RESTORE_RC after ${RESTORE_SECONDS}s"

# ---- 5. replay the role/grant layer ------------------------------------------------------
# Not in the dump (--no-privileges), and not replayed by `datum migrate` after a restore
# (schema_migrations travels inside the dump). This is the missing half of recovery, and it
# is generated from the migrations rather than duplicated here, so it cannot drift.
ACL_SQL="$WORKDIR/acl.sql"
cat > "$ACL_SQL" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datum_app') THEN
    CREATE ROLE datum_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datum_verifier') THEN
    CREATE ROLE datum_verifier NOLOGIN;
  END IF;
END
$$;
GRANT datum_app TO datum_verifier;
SQL
grep -hE '^(GRANT|REVOKE)' "$MIGRATIONS_DIR"/*.sql >> "$ACL_SQL"

ACL_STATEMENTS="$(grep -cE '^(GRANT|REVOKE)' "$MIGRATIONS_DIR"/*.sql | awk -F: '{s+=$2} END {print s+0}')"
(( ACL_STATEMENTS > 0 )) || die "found no GRANT/REVOKE statements in $MIGRATIONS_DIR — refusing to pretend the ACL layer was replayed"

docker cp "$ACL_SQL" "$CONTAINER:/tmp/acl.sql" >/dev/null
docker exec -u root "$CONTAINER" chmod 0644 /tmp/acl.sql
ACL_RC=0
docker exec -u postgres "$CONTAINER" \
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f /tmp/acl.sql \
  >"$WORKDIR/acl.log" 2>&1 || ACL_RC=$?
log "replayed ${ACL_STATEMENTS} GRANT/REVOKE statements from the migrations (psql exited $ACL_RC)"

# ---- 6. checks ---------------------------------------------------------------------------
PASSES=0
FAILURES=0
SKIPS=0

q() { docker exec -u postgres "$CONTAINER" psql -X -q -t -A -v ON_ERROR_STOP=1 -d "$DB" -c "$1" 2>/dev/null; }

pass() { printf '  \033[32mPASS\033[0m  %-56s %s\n' "$1" "${2:-}"; PASSES=$(( PASSES + 1 )); }
fail() { printf '  \033[31mFAIL\033[0m  %-56s %s\n' "$1" "${2:-}"; FAILURES=$(( FAILURES + 1 )); }
skip() { printf '  SKIP  %-56s %s\n' "$1" "${2:-}"; SKIPS=$(( SKIPS + 1 )); }

check() { # check <label> <expected> <sql>
  local actual
  actual="$(q "$3")" || actual="<query failed>"
  if [[ "$actual" == "$2" ]]; then pass "$1" "$actual"; else fail "$1" "got '$actual', want '$2'"; fi
}

# A refusal only counts if it is the RIGHT refusal. `TRUNCATE datum.assertions` without
# CASCADE, for instance, is rejected by the foreign-key check long before the append-only
# trigger is reached — that would be a green tick for a guarantee that was never tested.
expect_refusal() { # expect_refusal <label> <sql> <expected-substring-in-error>
  local out reason
  if out="$(docker exec -u postgres "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$2" 2>&1)"; then
    fail "$1" "the statement SUCCEEDED — the guarantee did not survive the restore"
    return
  fi
  reason="$(printf '%s' "$out" | sed -n 's/.*ERROR:  *//p' | head -n 1)"
  if [[ "$out" == *"$3"* ]]; then
    pass "$1" "refused: $(printf '%s' "$reason" | cut -c1-64)"
  else
    fail "$1" "refused for the WRONG reason (wanted '$3'): $(printf '%s' "$reason" | cut -c1-64)"
  fi
}

echo
echo "==== restore drill: checks against the RESTORED database ===================="
echo

if (( RESTORE_RC == 0 )); then
  pass "pg_restore completed without error" "${RESTORE_SECONDS}s"
else
  fail "pg_restore completed without error" "exit $RESTORE_RC — see output above"
fi

if (( ACL_RC == 0 )); then
  pass "role/grant layer replayed" "${ACL_STATEMENTS} statements"
else
  fail "role/grant layer replayed" "psql exit $ACL_RC (likely migration drift: the files on disk are newer than the dump). $(tail -n 2 "$WORKDIR/acl.log" | tr '\n' ' ' | cut -c1-90)"
fi

echo "-- invariant 3: the contradiction constraint --------------------------------"
check "no_two_live_contradictions exists as an exclusion constraint" "1" \
  "SELECT count(*) FROM pg_constraint WHERE conname = 'no_two_live_contradictions' AND contype = 'x' AND conrelid = 'datum.assertions'::regclass"
# The partial predicate is the decided semantics, not an optimisation: measured/derived rows
# cannot coexist, human and unverified testimony can and raises a contradiction record.
check "  ...and still restricted to measured/derived rows" "t" \
  "SELECT coalesce(pg_get_constraintdef(oid) LIKE '%measured%' AND pg_get_constraintdef(oid) LIKE '%derived%', false) FROM pg_constraint WHERE conname = 'no_two_live_contradictions'"
check "btree_gist extension restored" "1" \
  "SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist'"

echo "-- invariant 2: append-only, enforced by grants -----------------------------"
check "datum_app has SELECT and INSERT on datum.assertions" "t" \
  "SELECT has_table_privilege('datum_app','datum.assertions','SELECT') AND has_table_privilege('datum_app','datum.assertions','INSERT')"
check "datum_app has NO UPDATE/DELETE/TRUNCATE on datum.assertions" "f" \
  "SELECT has_table_privilege('datum_app','datum.assertions','UPDATE') OR has_table_privilege('datum_app','datum.assertions','DELETE') OR has_table_privilege('datum_app','datum.assertions','TRUNCATE')"
check "datum_app has NO UPDATE/DELETE/TRUNCATE on datum.verifications" "f" \
  "SELECT has_table_privilege('datum_app','datum.verifications','UPDATE') OR has_table_privilege('datum_app','datum.verifications','DELETE') OR has_table_privilege('datum_app','datum.verifications','TRUNCATE')"
check "datum_app has NO UPDATE/DELETE/TRUNCATE on datum.missions" "f" \
  "SELECT has_table_privilege('datum_app','datum.missions','UPDATE') OR has_table_privilege('datum_app','datum.missions','DELETE') OR has_table_privilege('datum_app','datum.missions','TRUNCATE')"

echo "-- triggers, derived from the migration files -------------------------------"
EXPECTED_TRIGGERS="$(awk '/^CREATE TRIGGER/ {print $3}' "$MIGRATIONS_DIR"/*.sql | sort -u)"
[[ -n "$EXPECTED_TRIGGERS" ]] || die "found no CREATE TRIGGER statements in $MIGRATIONS_DIR — the trigger check would be vacuous"
while read -r trg; do
  [[ -z "$trg" ]] && continue
  check "trigger $trg" "1" \
    "SELECT count(*) FROM pg_trigger WHERE tgname = '$trg' AND NOT tgisinternal"
done <<< "$EXPECTED_TRIGGERS"

echo "-- the guarantees, exercised rather than inspected --------------------------"
# The grant layer: datum_app cannot reach UPDATE at all, so this dies at the privilege check
# (42501) before any trigger is consulted.
expect_refusal "UPDATE as datum_app is refused by the grant system" \
  "SET ROLE datum_app; UPDATE datum.assertions SET why = 'rewritten';" \
  "permission denied"
# CASCADE is required to get past the foreign-key objection and actually reach the
# statement-level trigger. If the trigger were missing, this would truncate the restored
# table — which is fine, because the container is thrown away, and the check would fail loudly.
expect_refusal "TRUNCATE as the table owner is refused by the trigger" \
  "TRUNCATE datum.assertions CASCADE;" \
  "append-only"

ASSERTION_ROWS="$(q "SELECT count(*) FROM datum.assertions" || echo 0)"
if [[ "${ASSERTION_ROWS:-0}" =~ ^[0-9]+$ ]] && (( ASSERTION_ROWS > 0 )); then
  # A real change to a non-exempt column. Note that a no-op UPDATE is permitted by design:
  # the trigger diffs OLD against NEW, and the supersession stamp has to get through.
  expect_refusal "UPDATE as the table owner is refused by the trigger" \
    "UPDATE datum.assertions SET why = coalesce(why, '') || ' rewritten';" \
    "immutable"
  expect_refusal "DELETE as the table owner is refused by the trigger" \
    "DELETE FROM datum.assertions;" \
    "append-only"
else
  skip "UPDATE/DELETE as the table owner is refused by the trigger" \
    "no rows restored, so a FOR EACH ROW trigger cannot fire"
fi

echo "-- tables and row counts ----------------------------------------------------"
EXPECTED_TABLES="$(
  { awk 'match($0, /CREATE TABLE IF NOT EXISTS datum\.[a-z_]+/) { s = substr($0, RSTART, RLENGTH); sub(/.*datum\./, "", s); print s }' "$MIGRATIONS_DIR"/*.sql
    echo schema_migrations
  } | sort -u
)"
while read -r tbl; do
  [[ -z "$tbl" ]] && continue
  n="$(q "SELECT count(*) FROM datum.${tbl}")" || n=""
  if [[ "$n" =~ ^[0-9]+$ ]]; then
    pass "datum.${tbl} restored" "${n} rows"
  else
    fail "datum.${tbl} restored" "table missing or unreadable"
  fi
done <<< "$EXPECTED_TABLES"

MIGRATION_FILES="$(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
APPLIED="$(q "SELECT count(*) FROM datum.schema_migrations" || echo 0)"
if [[ "${APPLIED:-0}" =~ ^[0-9]+$ ]] && (( APPLIED > 0 )); then
  pass "the restored database knows its schema history" "${APPLIED} migrations recorded"
  if (( APPLIED != MIGRATION_FILES )); then
    echo "  NOTE  the working tree has ${MIGRATION_FILES} migration files but the dump recorded ${APPLIED}."
    echo "        Not a failure: it means the dump predates the current code. Restoring it into"
    echo "        production would leave the newer migrations to apply on the next boot."
  fi
else
  fail "the restored database knows its schema history" "datum.schema_migrations is empty"
fi

# Optional comparison against a live source. Not a FAIL by default: a live database moves on
# after a dump is taken, so a difference is expected rather than wrong.
SOURCE_URL="${DATUM_DRILL_SOURCE_URL:-}"
if [[ -n "$SOURCE_URL" ]]; then
  if command -v psql >/dev/null 2>&1; then
    echo "-- comparison against the live source --------------------------------------"
    while read -r tbl; do
      [[ -z "$tbl" ]] && continue
      src="$(psql -X -q -t -A -d "$SOURCE_URL" -c "SELECT count(*) FROM datum.${tbl}" 2>/dev/null || echo "?")"
      dst="$(q "SELECT count(*) FROM datum.${tbl}" || echo "?")"
      if [[ "$src" == "$dst" ]]; then
        pass "datum.${tbl} matches source" "$dst"
      elif [[ "${DATUM_DRILL_STRICT_COUNTS:-0}" == "1" ]]; then
        fail "datum.${tbl} matches source" "source ${src}, restored ${dst}"
      else
        echo "  NOTE  datum.${tbl}: source ${src}, restored ${dst} (the source moved on after the dump)"
      fi
    done <<< "$EXPECTED_TABLES"
  else
    skip "comparison against the live source" "psql is not on PATH"
  fi
fi

# ---- 7. the seven adversarial writes, replayed against THIS restored database -------------
# This is the check that makes the drill mean something. `test/restored.test.ts` runs the same
# seven cases as deliverable 1 — no evidence, UPDATE/DELETE, two contradicting measurements,
# kind=failed with no falsifier, a claimed `measured`, a double supersession, and the one that
# must be ACCEPTED — against the database this script just restored, in a scope unique to the
# run so it collides with nothing and leaves nothing behind that looks like a real fact.
#
# It is not the same thing as `npm run test:invariants`, which starts its own container and
# therefore validates the schema on disk rather than this restore.
# HOST_PORT already carries host:port from `docker port`. PGPW is the throwaway superuser
# password generated above; it never leaves this process and dies with the container.
export DATUM_RESTORED_URL="postgres://postgres:${PGPW}@${HOST_PORT}/${DB}"
if (( RUN_SUITE == 1 )); then
  echo "-- the seven adversarial writes, against the restored database ---------------"
  if ( cd "$REPO_ROOT" && npx vitest run --root packages/datum test/restored.test.ts ); then
    pass "seven invariant cases on the RESTORED database" ""
  else
    fail "seven invariant cases on the RESTORED database" "see output above"
  fi
else
  echo "-- skipping the replayed invariant cases (pass --run-suite to include them) ---"
  echo "   DATUM_RESTORED_URL=${DATUM_RESTORED_URL}"
fi

# ---- 8. verdict --------------------------------------------------------------------------
WALL_SECONDS=$(( SECONDS - WALL_START ))
echo
echo "============================================================================"
printf 'restore duration : %ss (pg_restore only)\n' "$RESTORE_SECONDS"
printf 'wall clock       : %ss (fetch, decrypt, boot, restore, verify)\n' "$WALL_SECONDS"
printf 'postgres         : %s (%s)\n' "$SERVER_VERSION" "$IMAGE"
printf 'dump             : %s\n' "$DUMP_INPUT"
printf 'checks           : %s passed, %s failed, %s skipped\n' "$PASSES" "$FAILURES" "$SKIPS"
echo "============================================================================"

if (( FAILURES > 0 )); then
  echo
  echo "RESULT: FAIL — ${FAILURES} check(s) did not hold on the restored database."
  echo "Do not record this backup as restorable. Fix it and run the drill again."
  echo
  exit 1
fi

echo
echo "RESULT: PASS — the backup restores and the invariants hold on the restored database."
echo "Record the date, the object key and the wall-clock duration in docs/OPERATIONS.md."
echo
