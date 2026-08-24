# Datum

**A datum is the fixed reference point every measurement is taken from.** In surveying and geodesy
it is the thing that makes independent instruments agree — which is the job here: making any number
of agents, worktrees, projects and humans agree on the same facts.

Datum is an append-only, bitemporal fact store with **mandatory provenance on write**. It records
what it is told, with evidence, or it **rejects the write**. Nothing is ever updated or deleted; a
correction is a new assertion that supersedes the old one. An agent **cannot claim that something
was measured** — a verification worker earns that label by resolving the commit the evidence names
and checking it is contained where the evidence claims.

> *Is that on datum?* — is the claim verified. *Take a datum* — read current truth. *That's off
> datum* — superseded.

---

## Run it in two commands

```bash
printf 'DATUM_ADMIN_PASSWORD=%s\nDATUM_SESSION_SECRET=%s\n' \
  "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" > .env
docker compose up
```

Then open **<http://localhost:8080/admin>** and sign in with the password in your new `.env`.
The first API key is printed once in the startup logs — look for `COPY THIS NOW`.

There is no default password in this image. The server refuses to boot without a credential,
because a shipped default password is a CVE, not a convenience.

Want something to click through?

```bash
docker compose exec datum node packages/datum/dist/cli/index.js seed --example
```

That loads a small synthetic fixture with a supersession chain, a contested pair, and a mission
whose gate honestly reports that it has no qualifying evidence.

---

## The five invariants

This table is the product. A write that violates any of these is **rejected by the database** with
a machine-readable `reason`, not warned about and kept.

| # | invariant | enforced by | `reason` you get back |
|---|---|---|---|
| 1 | No assertion without evidence | `CHECK` | `evidence_required` |
| 2 | No mutation, ever | `REVOKE UPDATE, DELETE` **and** a trigger | `insufficient_privilege`, `assertions_are_immutable`, `assertions_are_append_only` |
| 3 | No two live contradicting assertions, within the machine tier | `EXCLUDE USING gist` + `btree_gist` | `no_two_live_contradictions` |
| 4 | Confidence is earned, never claimed | role gate + verification worker | `confidence_is_earned` |
| 5 | No target without a machine-checkable gate | `CHECK` | `target_requires_machine_checkable_gate`, `active_mission_requires_gate` |

Try it:

```bash
curl -sS localhost:8080/v1/assert -H "authorization: Bearer $DATUM_KEY" \
  -H 'content-type: application/json' -d '{
    "scope":"org/local/proj/demo","subject":"engine","predicate":"tok_s",
    "object":{"value":757.5,"unit":"tok/s"},"kind":"measured",
    "confidence":"measured",
    "evidence":{"source":"a benchmark I ran"}
  }'
```

```json
{
  "ok": false,
  "reason": "confidence_is_earned",
  "invariant": 4,
  "says": "An agent cannot assert `measured`. Write it `unverified`; the verification worker promotes it once evidence.commit resolves and is contained where claimed.",
  "hint": "Assert as unverified. The verification worker promotes it to measured once evidence.commit resolves and is contained where claimed."
}
```

Every refusal is also recorded, and `/admin` has a live screen for them. It is the most persuasive
screen in the product, because it shows the invariants biting in real time.

### Contradictions are advisory across authority tiers

Two `measured` rows cannot disagree about the same scope, subject, predicate and period — that is
physically un-insertable, because one of them is wrong and you should have to say which.

A **human** contradicting an instrument is different. That write **lands**, both rows stay live,
a `contradiction` record is raised, and every read returns both marked `contested: true`. This is
safe rather than sloppy because a mission gate declares the evidence class it accepts and evaluates
only rows of that class, so testimony can never satisfy a gate demanding `measured`. The
disagreement becomes visible without becoming load-bearing.

---

## Deploy it somewhere

### `docker compose` — the path that never breaks

Above. Same image, no platform dependency. This is the one that survives any vendor's pricing
change, so it is the one that is kept working.

### Fly.io

**Fly does not have a one-click deploy button.** It had one in 2020 and it is gone; the closest
current thing is a CLI command, and pointing a "Deploy" badge at a docs page would be worse than
saying so. So:

```bash
brew install flyctl && fly auth login          # or see fly.io/docs/flyctl/install
fly launch --from https://github.com/aeonmindai/datum
```

For the two-Machine production layout — the API plus **self-hosted Postgres on its own Machine with
a volume**, reachable only over Fly's private 6PN network — use the committed configs:

```bash
POSTGRES_PASSWORD="$(openssl rand -base64 24)" ./scripts/pg-machine-init.sh   # prints the DATABASE_URL to set
fly secrets set -a datum DATABASE_URL='...' \
  DATUM_ADMIN_PASSWORD_HASH="$(npx @aeonmind/datum hash-password 'your-password')" \
  DATUM_SESSION_SECRET="$(openssl rand -hex 32)"
fly deploy
```

`fly.toml` sets `min_machines_running = 1` and `auto_stop_machines = "off"` on purpose: the read
path is specified at p99 < 10 ms, and scale-to-zero does not degrade that, it deletes it.

### Railway

Railway's button needs a **published template id**, and no template has been published for this
repo yet, so there is no button to click here — see [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for
the two-minute publish. Once published, the badge is:

```markdown
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/YOUR_TEMPLATE_ID)
```

`railway.json` is committed and ready. Railway can provision Postgres as a second service and
generate `DATUM_SESSION_SECRET`; `DATUM_ADMIN_PASSWORD` is a required user input.

### Any Postgres, anywhere

Postgres **13 or newer**. The one exotic thing the schema needs is `btree_gist`, which ships in
contrib and has been a *trusted* extension since PG13, so a non-superuser database owner can create
it. Migrations run automatically on boot, idempotently, and are safe to run concurrently.

Postgres 18 could express invariant 3 as `WITHOUT OVERLAPS`. This deliberately does not use it: the
exclusion constraint gives the identical guarantee, has been hardened since PG9.x, and keeps your
host a swappable decision instead of welding the core invariant to one vendor's newest feature.

---

## Configuration

Nothing about any one organisation is hardcoded. `DATUM_ORG=acme` yields the scope root `org/acme`,
and no query assumes the configured root is the top of the tree.

| variable | required | what it does |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string |
| `DATUM_ADMIN_PASSWORD_HASH` | one of these two | argon2id hash from `datum hash-password` |
| `DATUM_ADMIN_PASSWORD` | one of these two | plaintext; hashed at boot, **never persisted**, logs a warning telling you to switch |
| `DATUM_SESSION_SECRET` | **yes** | ≥32 chars, `openssl rand -hex 32` |
| `DATUM_ORG` | no (`local`) | scope root label |
| `PORT` / `HOST` | no (`8080` / `0.0.0.0`) | listen address; `PORT=0` picks any free port |
| `DATUM_PUBLIC_URL` | no | used for cookie `Secure` and RFC 9728 metadata |
| `DATUM_GIT_MIRRORS` | no | `owner/repo=/path/to/clone,...` — how the worker resolves commits |
| `DATUM_GITHUB_TOKEN` | no | fallback commit resolution via the GitHub API |
| `DATUM_VERIFY_INTERVAL_MS` | no (`15000`) | verification poll interval |
| `DATUM_LOGIN_ATTEMPTS` / `_WINDOW_SECONDS` | no (`5` / `900`) | `/admin` login rate limit |

Full list with comments: [`.env.example`](.env.example).

**If you configure no verification path at all, nothing is ever promoted to `measured`.** That is
correct behaviour, not a bug, and the server says so at startup.

---

## Using it

### The CLI

```bash
npm i -g @aeonmind/datum

cd your-repo
datum link                 # derives the project from your git remote, registers repo + worktree
datum mode isolated        # stop inheriting org-scope facts (writes a superseding assertion)
datum mode global          # start again; nothing is rewritten either way
datum status               # who am I, which scope, which mode, what the mission is and which gates are open
```

`datum link` writes `.datum.toml`, which is safe to commit: it holds the scope and server, never the
key. Many worktrees of one repo are **one project with many nodes**, not many projects.

### `/v1` — the real interface

```
POST /v1/assert            record a fact (evidence.source required)
POST /v1/supersede         correct one (there is no update path)
GET  /v1/ask               exact-first read; ?as_of=<sequence> for "what did we believe then"
GET  /v1/why/:id           evidence, verification outcome, full supersession chain, contradictions
GET  /v1/state             mode, sequence, counts by confidence, binding rules, missions and gates
GET  /v1/missions          POST to create; an active mission needs at least one checkable gate
GET  /v1/nodes             the registry; POST to register or heartbeat
POST /v1/mode              flip global/isolated as an assertion
GET  /healthz              unauthenticated
```

Auth is `Authorization: Bearer dtm_live_…`. Keys are minted in `/admin`, bound to a scope subtree,
and carry a permission set (`read`, `assert`, `supersede`, `admin`).

### `/mcp` — a facade, not the substrate

Six tools: `state`, `ask`, `why`, `assert`, `supersede`, `nodes`. Six, not thirty, because every
tool definition is injected into every agent session that connects — a chatty MCP server is a
permanent context tax on everything downstream of it. Responses are provenance-dense and budgeted
in **hundreds of bytes**, not kilobytes:

```
engine.aggregate_tok_s_at_b256=757.5 tok/s | measured | acme/proj/arc | arc@4d03b9e2~release/openrouter-ready | s4417
engine.aggregate_tok_s_at_b256=16600 tok/s | confirmed-by-human | acme/proj/arc | human:Jish | s4419 | CONTESTED
```

A bare number cannot leave the system: the confidence class and the evidence are on every line, and
a contested pair is never truncated to one side, whatever the byte budget says.

`/v1` is the real interface. MCP `2026-07-28` made statelessness normative and removed sessions,
the handshake, `ping` and resumability, which makes presence and heartbeats unrepresentable — so the
registry cannot live there.

---

## Operating it

You are the database operator, so this is in scope, not a later chore:

```bash
./scripts/backup.sh          # pg_dump, age-encrypted, to any S3-compatible bucket
./scripts/restore-drill.sh   # restore into a throwaway container and re-assert the invariants
```

The bucket must live **outside** your Fly organisation: a backup inside the blast radius is not a
backup. And a backup you have never restored is not a backup — by this project's own doctrine an
untested backup is an unverified claim, so the drill is a script you can run, not a paragraph.

One trap worth knowing, because it bites silently: `pg_dump --no-privileges` does not carry the
`GRANT`/`REVOKE` layer, and that layer is invariant 2's first line of defence. `restore-drill.sh`
replays the grants from the migration files and *then* asserts that the runtime role holds no
`UPDATE`, `DELETE` or `TRUNCATE`. Details in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Nothing calls home

No telemetry, no license check, no phone-home, no analytics. The only outbound request Datum can
ever make is to `api.github.com`, and only if you set `DATUM_GITHUB_TOKEN` to let the verification
worker resolve commits. Read the network calls; there are none to find.

## Development

```bash
npm install
npm run test        # needs a working docker daemon: it starts real Postgres
npm run build
```

The test suite never stubs the database. The invariants under test *are* database invariants — an
exclusion constraint, a grant, a trigger — so a fake would test nothing. Every invariant test is
**mutation-checked**: the suite drops the constraint and asserts the outcome flips, with both values
recorded in [`reports/invariants.md`](reports/invariants.md).

```
packages/datum/migrations   the schema, one numbered file per concern
packages/datum/src/domain   assertions, scopes, missions, contradictions
packages/datum/src/worker   the verification worker
packages/datum/src/http     /v1, /mcp, /admin, auth
packages/datum/src/cli      the datum binary
packages/admin              the admin panel (React + Vite + Tailwind)
```

Design and evidence: [`HANDOFF.md`](HANDOFF.md). The `research/` directory is 523 KB of sourced
prior art behind each decision; open a file to challenge a specific one.

## Not in this version

Projections to Discord and Linear, NATS (the outbox table is written but not consumed), registry
heartbeats, embeddings, multi-tenant auth, OIDC token exchange, and contradiction *resolution*
workflow beyond a queue and a resolve action.

Multi-tenancy and enterprise features will land in a separate private repo that depends on this one.
This repo contains no enterprise stubs, no paid-feature flags and no `if (license)` branches. You
should never hit a wall in here advertising a product.

## License

Apache-2.0. Copyright Aeonmind AI.
