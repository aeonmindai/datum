#!/usr/bin/env bash
#
# backup.sh — encrypted pg_dump of a Datum database to S3-compatible object storage.
#
# Usage:
#   ./scripts/backup.sh [--dry-run] [--no-prune]
#
# Reads everything from the environment (see .env.example):
#
#   DATABASE_URL                 required  postgres:// connection string to dump
#   DATUM_BACKUP_BUCKET          required  bucket name
#   DATUM_BACKUP_AGE_RECIPIENT   required  age PUBLIC key to encrypt to
#   DATUM_BACKUP_ENDPOINT        optional  S3-compatible endpoint; omit for AWS S3 proper
#   DATUM_BACKUP_PREFIX          optional  key prefix inside the bucket (default: datum)
#   DATUM_BACKUP_RETENTION_DAYS  optional  prune objects older than this (default: 30)
#   DATUM_BACKUP_MIN_BYTES       optional  fail if the dump is smaller (default: 8192)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION   required by the aws CLI
#
# Writes:  s3://$BUCKET/$PREFIX/YYYY/MM/DD/datum-<utc-timestamp>.dump.age
#
# THE BUCKET MUST LIVE OUTSIDE THE FLY ORGANISATION that runs the database. A backup inside
# the blast radius is not a backup: the same compromised token, the same billing failure and
# the same operator mistake that loses the volume also loses a backup stored beside it. Use a
# different provider, or at minimum a different account with its own credentials.
#
# Encryption is to a PUBLIC key only. The machine taking backups cannot read them back, which
# means stealing the backup host yields ciphertext. Keep the age identity file somewhere else
# entirely — a password manager, not this repo, not the server.
#
# Exit codes: 0 success, 1 precondition/verification failure.

set -euo pipefail

# ---- usage -------------------------------------------------------------------------------
DRY_RUN=0
PRUNE=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-prune) PRUNE=0 ;;
    -h|--help)
      sed -n '2,31p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'
      exit 0
      ;;
    *)
      echo "backup.sh: unknown argument: $arg" >&2
      echo "try: $0 --help" >&2
      exit 1
      ;;
  esac
done

die() { echo "backup.sh: FATAL: $*" >&2; exit 1; }
log() { echo "[backup] $*"; }

# ---- preconditions -----------------------------------------------------------------------
for tool in pg_dump age aws; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not on PATH.
  pg_dump: install the Postgres client (postgresql-client / postgresql@18)
  age:     https://github.com/FiloSottile/age  (brew install age, apt install age)
  aws:     https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
done

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DATUM_BACKUP_BUCKET:?DATUM_BACKUP_BUCKET is required}"
: "${DATUM_BACKUP_AGE_RECIPIENT:?DATUM_BACKUP_AGE_RECIPIENT is required (an age PUBLIC key)}"

BUCKET="$DATUM_BACKUP_BUCKET"
PREFIX="${DATUM_BACKUP_PREFIX:-datum}"
RECIPIENT="$DATUM_BACKUP_AGE_RECIPIENT"
RETENTION_DAYS="${DATUM_BACKUP_RETENTION_DAYS:-30}"
MIN_BYTES="${DATUM_BACKUP_MIN_BYTES:-8192}"

case "$RECIPIENT" in
  age1PLACEHOLDER*) die "DATUM_BACKUP_AGE_RECIPIENT is still the placeholder from .env.example.
  Generate your own:  age-keygen -o datum-backup.key" ;;
  age1*|ssh-*) : ;;
  *) die "DATUM_BACKUP_AGE_RECIPIENT does not look like an age recipient (age1... or ssh-...)" ;;
esac

# The aws CLI takes --endpoint-url only when one is configured; AWS S3 proper wants it absent.
AWS_ARGS=()
if [[ -n "${DATUM_BACKUP_ENDPOINT:-}" ]]; then
  AWS_ARGS+=(--endpoint-url "$DATUM_BACKUP_ENDPOINT")
fi

# Never print DATABASE_URL: it carries the password.
redacted_dsn() {
  # postgres://user:pass@host:port/db  ->  postgres://user:***@host:port/db
  printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'
}

# ---- naming ------------------------------------------------------------------------------
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATE_PATH="$(date -u +%Y/%m/%d)"
OBJECT_KEY="${PREFIX}/${DATE_PATH}/datum-${STAMP}.dump.age"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/datum-backup.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT
DUMP_FILE="$WORKDIR/datum-${STAMP}.dump.age"

log "source:    $(redacted_dsn)"
log "target:    s3://${BUCKET}/${OBJECT_KEY}"
log "recipient: ${RECIPIENT}"

# ---- dump + encrypt ----------------------------------------------------------------------
# Custom format, because it is what pg_restore takes: selective restore, parallel restore,
# and a table of contents you can read without restoring (`pg_restore --list`).
#
# --no-owner --no-privileges keeps the dump restorable into a cluster whose roles differ from
# production. The cost is real and must be understood: ACLs are NOT in this dump, so a
# restored database has the tables, the triggers and the exclusion constraint but none of the
# GRANT/REVOKE layer that enforces invariant 2 at the privilege level. Recovery is therefore
# restore + replay of the role/grant layer, and restore-drill.sh does exactly that and then
# asserts the result. Note that `datum.schema_migrations` travels inside the dump, so a plain
# `datum migrate` after a restore is a no-op and will NOT put the grants back.
#
# pipefail is what makes a failed pg_dump fail this script instead of uploading a truncated,
# perfectly-encrypted, perfectly-useless object.
if [[ "$DRY_RUN" == "1" ]]; then
  log "--dry-run: would dump, encrypt, upload and prune; doing none of it"
  exit 0
fi

log "dumping..."
START="$SECONDS"
PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}" \
  pg_dump --dbname="$DATABASE_URL" \
          --format=custom \
          --no-owner \
          --no-privileges \
  | age -r "$RECIPIENT" -o "$DUMP_FILE"
DUMP_SECONDS=$(( SECONDS - START ))

[[ -f "$DUMP_FILE" ]] || die "pg_dump produced no file"

LOCAL_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
log "dumped and encrypted ${LOCAL_BYTES} bytes in ${DUMP_SECONDS}s"

if (( LOCAL_BYTES < MIN_BYTES )); then
  die "dump is suspiciously small: ${LOCAL_BYTES} bytes < DATUM_BACKUP_MIN_BYTES=${MIN_BYTES}.
  Refusing to upload it, and refusing to prune older objects. A shrinking dump is how silent
  data loss looks from the outside: check the database before you trust this."
fi

# ---- upload ------------------------------------------------------------------------------
log "uploading..."
aws "${AWS_ARGS[@]}" s3 cp "$DUMP_FILE" "s3://${BUCKET}/${OBJECT_KEY}" --only-show-errors

# ---- verify it is actually there ---------------------------------------------------------
# `aws s3 cp` exiting 0 is a claim. head-object is the evidence.
REMOTE_BYTES="$(
  aws "${AWS_ARGS[@]}" s3api head-object \
    --bucket "$BUCKET" --key "$OBJECT_KEY" \
    --query 'ContentLength' --output text
)"

if [[ "$REMOTE_BYTES" != "$LOCAL_BYTES" ]]; then
  die "uploaded object is ${REMOTE_BYTES} bytes but the local dump is ${LOCAL_BYTES}.
  The object at s3://${BUCKET}/${OBJECT_KEY} is not the backup you just took."
fi

log "VERIFIED s3://${BUCKET}/${OBJECT_KEY} (${REMOTE_BYTES} bytes)"

# ---- prune -------------------------------------------------------------------------------
# Only after a verified upload, so a broken backup run can never be the thing that deletes
# the last good one.
if [[ "$PRUNE" != "1" ]]; then
  log "--no-prune: keeping every object"
  exit 0
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 1 )); then
  die "DATUM_BACKUP_RETENTION_DAYS must be a positive integer (got '${RETENTION_DAYS}')"
fi

# GNU date and BSD date disagree about relative dates; support both rather than assuming.
cutoff_date() {
  date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%d 2>/dev/null \
    || date -u -v-"${RETENTION_DAYS}"d +%Y-%m-%d
}
CUTOFF="$(cutoff_date)"
log "pruning ${PREFIX}/ objects last modified before ${CUTOFF} (retention ${RETENTION_DAYS}d)"

LISTING="$WORKDIR/listing.txt"
# S3 renders LastModified as a fixed-width ISO 8601 string, so comparing the leading
# YYYY-MM-DD lexicographically is exact and needs no epoch arithmetic.
aws "${AWS_ARGS[@]}" s3api list-objects-v2 \
  --bucket "$BUCKET" --prefix "${PREFIX}/" \
  --query 'Contents[].[Key,LastModified]' --output text > "$LISTING"

PRUNED=0
KEPT=0
while read -r key lastmod _rest; do
  [[ -z "${key:-}" || "$key" == "None" ]] && continue
  if [[ "${lastmod:0:10}" < "$CUTOFF" ]]; then
    aws "${AWS_ARGS[@]}" s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null
    log "pruned ${key} (${lastmod})"
    PRUNED=$(( PRUNED + 1 ))
  else
    KEPT=$(( KEPT + 1 ))
  fi
done < "$LISTING"

log "done: 1 uploaded, ${PRUNED} pruned, ${KEPT} retained"
log "a backup you have never restored is not a backup — run ./scripts/restore-drill.sh"
