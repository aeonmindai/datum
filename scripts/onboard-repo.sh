#!/usr/bin/env bash
#
# Load one repository into a running Datum and print the MCP config its agents need.
#
# This exists because "is it ready to use" turned out to mean six manual commands in a
# particular order, and the answer to a question that takes six commands is always "not yet".
# Everything here is idempotent: run it again after any commit and it re-indexes rather than
# duplicating, because assertions are content-addressed and episodes are hashed.
#
# What it deliberately does NOT do: mint a key silently, or write into a repo you did not name.
# The key is printed once and never stored, and the MCP block is printed for you to paste.
#
#   ./scripts/onboard-repo.sh --repo /path/to/arc --scope org/aeonmind/proj/arc [--transcripts DIR]
#
# Requires DATABASE_URL (operator commands run against the database, not the API) and, for the
# key, DATUM_URL plus an admin password. Reads DATUM_ADMIN_PASSWORD from the environment; never
# from a file, and never echoes it.

set -euo pipefail

REPO="" SCOPE="" TRANSCRIPTS="" SERVER="${DATUM_URL:-http://127.0.0.1:8080}" LABEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --scope) SCOPE="$2"; shift 2 ;;
    --transcripts) TRANSCRIPTS="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$REPO"  ]] || { echo "--repo is required" >&2; exit 2; }
[[ -n "$SCOPE" ]] || { echo "--scope is required" >&2; exit 2; }
[[ -d "$REPO/.git" ]] || { echo "$REPO is not a git repository" >&2; exit 2; }
: "${DATABASE_URL:?DATABASE_URL must be set — operator commands talk to the database}"

CLI="node node_modules/tsx/dist/cli.mjs packages/datum/src/cli/index.ts"
if [[ -f packages/datum/dist/cli/index.js ]]; then CLI="node packages/datum/dist/cli/index.js"; fi

# python3 rather than sed: BSD sed rejects the lazy quantifier this needs, and the script already
# depends on python3 for JSON. One interpreter is better than two dialects of regex.
OWNER_REPO="$(git -C "$REPO" remote get-url origin 2>/dev/null | python3 -c '
import re, sys
u = sys.stdin.read().strip()
m = re.search(r"[:/]([^/:]+/[^/]+?)(?:\.git)?/?$", u)
print(m.group(1) if m else "")')"
[[ -n "$OWNER_REPO" ]] || { echo "could not read origin from $REPO" >&2; exit 2; }
LABEL="${LABEL:-$(basename "$REPO")}"

echo "repo    $OWNER_REPO  ($REPO)"
echo "scope   $SCOPE"
echo "server  $SERVER"
echo

echo "--- 1/4  migrations (idempotent) ---"
$CLI migrate 2>&1 | tail -1

echo
echo "--- 2/4  code graph ---"
# Indexing happens where the code is; loading happens where the database is. A dirty tree is
# indexed anyway but warns, because an artifact claiming a commit whose contents differ from what
# was parsed is worse than no artifact.
ART="$(mktemp -t datum-graph-XXXXXX).json"
$CLI index --dir "$REPO" --emit "$ART" --quiet 2>&1 | grep -viE '^Load it with' || true
$CLI ingest-graph "$ART" 2>&1 | tail -2
rm -f "$ART"

echo
echo "--- 3/4  conversations ---"
if [[ -n "$TRANSCRIPTS" && -d "$TRANSCRIPTS" ]]; then
  $CLI ingest-sessions --dir "$TRANSCRIPTS" --scope "$SCOPE" --human "human:${USER}" 2>&1 | tail -1
else
  # Not a failure. A repo with no transcripts still gets facts, rules and the code graph; only
  # "what was said" is unavailable, and saying so is better than a silent zero.
  echo "  no --transcripts given: episodes will be empty, so \`recall\` has nothing to read."
  echo "  Claude Code transcripts usually live under ~/.claude/projects/<mangled-path>/"
fi

echo
echo "--- 4/4  a key for this repo's agents ---"
if [[ -z "${DATUM_ADMIN_PASSWORD:-}" ]]; then
  echo "  DATUM_ADMIN_PASSWORD not set, so no key was minted."
  echo "  Set it and re-run, or mint one in /admin. Nothing else here needs it."
else
  JAR="$(mktemp -t datum-jar-XXXXXX)"
  trap 'rm -f "$JAR"' EXIT
  curl -sS -X POST "$SERVER/admin/api/login" -H 'content-type: application/json' \
    -d "{\"password\":\"${DATUM_ADMIN_PASSWORD}\"}" -c "$JAR" -o /dev/null
  SECRET="$(curl -sS -b "$JAR" -X POST "$SERVER/admin/api/keys" \
    -H 'content-type: application/json' \
    -d "{\"label\":\"${LABEL}-agents\",\"scope\":\"${SCOPE}\",\"permissions\":[\"read\",\"assert\"]}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("secret",""))')"
  if [[ -z "$SECRET" ]]; then
    echo "  key minting failed — check the admin password and that $SERVER is reachable."
  else
    echo "  shown ONCE, not stored anywhere:"
    echo
    echo "    $SECRET"
    echo
    echo "  Paste into the repo's MCP config:"
    cat <<JSON

  {
    "mcpServers": {
      "datum": {
        "type": "http",
        "url": "${SERVER}/mcp",
        "headers": { "authorization": "Bearer ${SECRET}" }
      }
    }
  }
JSON
  fi
fi

echo
echo "--- state ---"
$CLI resume --scope "$SCOPE" --limit 3 2>&1 | head -6
echo
echo "Re-run after any commit to refresh the graph. Indexing is NOT automatic yet:"
echo "the graph is correct as of the commit above and says so on every answer."
