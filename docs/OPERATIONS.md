# Operations

Datum is a claim about durable truth. Running its store as a hobby would contradict the
pitch, so this file is a deliverable and not a later chore. Everything here is executable or
falsifiable; where a number is a quote rather than a measurement, it says so.

Files this document drives:

| file | what it is |
|---|---|
| `Dockerfile` | the one image, used by every deploy path |
| `docker-compose.yml` | Postgres + server on any box with Docker |
| `fly.toml` | the API app |
| `fly.postgres.toml` | the database app — our own Machine, latest Postgres |
| `railway.json` | Railway per-service deploy config (see the caveats in §8) |
| `.env.example` | every variable the server reads |
| `scripts/pg-machine-init.sh` | idempotent database bring-up on Fly |
| `scripts/backup.sh` | encrypted `pg_dump` to object storage |
| `scripts/restore-drill.sh` | the proof that the backup is real |

---

## 1. Architecture

Two Fly apps. One is replaceable, one holds everything.

```mermaid
graph LR
  C[clients: CLI, MCP, agents, browser] -->|HTTPS 443| P[Fly Proxy]
  P -->|8080| A["app: datum<br/>1 Machine, shared-cpu-1x 512MB<br/>stateless, min_machines_running = 1"]
  A -->|"6PN private only<br/>datum-db.internal:5432"| D["app: datum-db<br/>1 Machine, shared-cpu-1x 1GB<br/>postgres:18 + 10GB volume"]
  D -.->|"pg_dump → age → s3, daily"| B["object storage<br/>OUTSIDE the Fly org"]
```

Three properties of that picture are load-bearing:

- **The database is never publicly routable.** `fly.postgres.toml` declares no
  `[[services]]` at all, so `fly deploy` allocates no public address and the Fly Proxy has
  nothing to publish. 6PN reaches it directly at `datum-db.internal:5432`. Verify after every
  deploy: `fly ips list -a datum-db` must print nothing.
- **The API never scales to zero.** The read path is specified at p99 < 10 ms. A cold start
  is orders of magnitude above that, so `auto_stop_machines = "off"` is not a cost oversight.
- **Backups live outside the Fly organisation.** The same compromised token or billing
  failure that loses the volume also loses anything stored beside it.

Postgres is **our own Machine on `postgres:18`**, not Fly Managed Postgres: MPG is pinned to
Postgres 16, lists version upgrades among the things it does not yet do, and floors at
$38/mo. The schema deliberately stays portable to Postgres 13 — invariant 3 is an
`EXCLUDE USING gist` constraint, not PG18's `WITHOUT OVERLAPS` — so running the newest server
is a free choice rather than a dependency.

---

## 2. First deploy on Fly

`fly` app names are globally unique. If `datum` or `datum-db` is taken, pick your own and
pass `--app` / edit the `app =` line; nothing else in the repo refers to them.

```bash
# 0. once
fly auth login

# 1. the database: app, volume, password secret, Machine, readiness — all idempotent
export POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d +/=)"
./scripts/pg-machine-init.sh --org <your-fly-org>
# it prints the exact `fly secrets set ... DATABASE_URL=...` command, unexpanded, so the
# password never enters your scrollback. Run it while POSTGRES_PASSWORD is still set.

# 2. the API app
fly apps create --name datum --org <your-fly-org>
fly secrets set -a datum DATUM_SESSION_SECRET="$(openssl rand -hex 32)"
fly secrets set -a datum DATUM_ADMIN_PASSWORD_HASH='<paste from: datum hash-password ...>'
fly deploy -c fly.toml -a datum

# 3. the domain
fly certs add datum.example.com -a datum
fly certs show datum.example.com -a datum   # trust this, not any documentation

# 4. prove it
curl -fsS https://datum.example.com/healthz
fly ips list -a datum-db        # MUST be empty
fly logs -a datum | head -50    # `datum init` prints the first API key ONCE — copy it now
```

Only three secrets exist on the API app, and this repo contains none of their values:
`DATABASE_URL`, `DATUM_ADMIN_PASSWORD_HASH`, `DATUM_SESSION_SECRET`.

### Day-2 deploys

```bash
fly deploy -c fly.toml -a datum
fly releases -a datum
fly releases rollback -a datum          # or: fly deploy -i <previous image ref>
```

With a single API Machine a rolling deploy has a short gap while the Machine restarts.
Migrations run on boot and are idempotent, so a rollback of the image is safe as long as the
rolled-back code still understands the applied schema — migrations are forward-only by
design, and `datum.schema_migrations` records a checksum per file, so editing an applied
migration is an error rather than a mystery. If the gap matters, `fly scale count 2 -a datum`
(the app is stateless; only the database is a single writer).

---

## 3. Rotating credentials

**Admin password.** Nothing is stored in the database, so rotation is one secret.

```bash
# preferred: hash it yourself, the server never sees plaintext
datum hash-password 'the-new-password'
fly secrets set -a datum DATUM_ADMIN_PASSWORD_HASH='$argon2id$...'
# if DATUM_ADMIN_PASSWORD is also set, unset it — the hash wins, but leaving plaintext
# around defeats the point
fly secrets unset -a datum DATUM_ADMIN_PASSWORD
```

Setting a secret restarts the Machine, which ends every admin session anyway.

**Session secret.** Rotating it invalidates every `datum_session` cookie immediately. That is
the intended blast radius, and it is the correct response to a suspected session leak.

```bash
fly secrets set -a datum DATUM_SESSION_SECRET="$(openssl rand -hex 32)"
```

**Database password.** Note the trap: `POSTGRES_PASSWORD` is only read by `initdb`, on the
very first boot. Changing that secret later changes nothing. Rotate the real thing:

```bash
fly ssh console -a datum-db -C "psql -U datum -d datum -c \"ALTER ROLE datum PASSWORD 'new'\""
fly secrets set -a datum DATABASE_URL="postgres://datum:new@datum-db.internal:5432/datum"
fly secrets set -a datum-db POSTGRES_PASSWORD='new'   # keeps the two in sync for the future
```

**API keys** are managed from the admin panel (`/admin` → Keys) or the CLI. A key secret is
displayed exactly once at mint time; revocation is immediate and is a row, not a delete.

---

## 4. Backups

### What runs, and where

`scripts/backup.sh` does `pg_dump --format=custom --no-owner --no-privileges`, pipes it
through `age` to a **public** key, uploads to `s3://$BUCKET/datum/YYYY/MM/DD/datum-<utc>.dump.age`,
verifies the object with `head-object`, refuses to continue if the dump is suspiciously
small, and only then prunes objects older than `DATUM_BACKUP_RETENTION_DAYS` (default 30).

Encryption is to a public key only, so the host that takes backups **cannot read them back**.
Keep the age identity file in a password manager. Not in this repo, not on the server.

### Scheduling: a Fly scheduled Machine, not an external cron

This is the decision and the reason. The database is reachable only over 6PN, so a scheduler
that runs outside the Fly organisation **cannot reach it at all** without either publishing
Postgres (never) or handing a Fly deploy token to a third-party CI system so it can
`fly proxy` in. A scheduled Machine inside the org needs no new trust boundary and no new
credential; it dials `datum-db.internal` like everything else. The bucket still lives outside
the org, which is where the isolation that matters actually belongs.

`fly machine run --schedule` accepts `hourly`, `daily`, `weekly`, `monthly` — not cron
expressions. Daily is the default choice; switch to hourly if 24 hours of loss is too much
(see §6).

The runtime image is deliberately small and carries no `pg_dump`, `age` or `aws`, so the
scheduled Machine uses a tiny ops image. Keep this wherever you build ops images — it is not
committed here, because nothing in this repo should imply the API image contains backup tools:

```dockerfile
FROM postgres:18
RUN apt-get update \
 && apt-get install -y --no-install-recommends age awscli ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/bin/bash"]
```

```bash
# secrets for the backup job, scoped to the database app
fly secrets set -a datum-db \
  DATUM_BACKUP_BUCKET=... \
  DATUM_BACKUP_ENDPOINT=https://fly.storage.tigris.dev \
  DATUM_BACKUP_AGE_RECIPIENT=age1... \
  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_REGION=auto \
  DATABASE_URL="postgres://datum:$POSTGRES_PASSWORD@datum-db.internal:5432/datum"

# the schedule. --file-local injects the script from this repo, so improving backup.sh
# never means rebuilding the ops image.
fly machine run <your-ops-image> \
  -a datum-db \
  --schedule daily \
  --region sjc \
  --vm-size shared-cpu-1x --vm-memory 512 \
  --file-local /usr/local/bin/datum-backup.sh=./scripts/backup.sh \
  --entrypoint /bin/bash \
  -- -lc 'chmod +x /usr/local/bin/datum-backup.sh && /usr/local/bin/datum-backup.sh'

fly machine list -a datum-db      # confirm the scheduled Machine exists
fly logs -a datum-db              # confirm it ran, and that it printed VERIFIED
```

Volume snapshots are enabled separately in `fly.postgres.toml`
(`scheduled_snapshots = true`, `snapshot_retention = 14`). They are convenient and they are
**inside the blast radius**: a snapshot is a second copy on the same provider, under the same
account. Treat them as a fast-rollback tool, never as the backup of record.

### Alternative, if you insist on an external scheduler

GitHub Actions on a `schedule:` trigger, with a Fly deploy token in repository secrets, doing
`fly proxy 5432 -a datum-db` and pointing `DATABASE_URL` at `127.0.0.1:5432`. It works. It
also means a third party holds a token that can reach your private network, which is a strictly
larger attack surface than the option above for no operational gain.

---

## 5. The restore drill

> A backup you have never restored is not a backup. By this project's own doctrine — nothing
> is a result until it has actually run — an untested backup is an unverified claim, which is
> exactly the class of thing this store exists to refuse.

```bash
export DATUM_BACKUP_AGE_IDENTITY=~/.config/datum/backup-identity.key
./scripts/restore-drill.sh                    # newest object in the bucket
./scripts/restore-drill.sh --file some.dump.age
./scripts/restore-drill.sh --keep             # leave the container up to poke at
```

It fetches (or takes) a dump, decrypts it, starts a **throwaway** Postgres container,
restores into it with `pg_restore`, replays the role/grant layer, then asserts — against the
restored database, not against the code:

- `no_two_live_contradictions` exists, is `contype = 'x'`, and still carries its partial
  predicate, so `confirmed-by-human` and `unverified` rows remain exempt by design
- `btree_gist` came back with it
- every trigger the migrations create is present (the expected list is **derived from
  `packages/datum/migrations/*.sql` at runtime**, so it cannot rot)
- `datum_app` holds `SELECT`+`INSERT` and **not** `UPDATE`/`DELETE`/`TRUNCATE` on
  `datum.assertions`, `datum.verifications` and `datum.missions`
- a real `UPDATE` as `datum_app` is refused by the grant system; a real `UPDATE`, `DELETE`
  and `TRUNCATE` as the table **owner** are refused by the triggers — and each refusal is
  matched against the expected reason, because a `TRUNCATE` rejected by a foreign-key check
  is a green tick for a guarantee that was never tested
- every expected table restored, with its row counts printed

Exit code 0 means PASS, 1 means at least one check failed. Record every run below.

### One thing to understand about the grant layer

`backup.sh` dumps with `--no-privileges`, which keeps the dump restorable into a cluster whose
roles differ from production. The cost is real: **ACLs are not in the dump**, and
`datum.schema_migrations` *is* — so running `datum migrate` after a restore is a no-op and
will not put the grants back. Recovery is therefore **restore + replay of the role/grant
layer**, and the drill performs that replay from the migration files and then asserts the
result. Without it, "datum_app holds no UPDATE" would pass vacuously on a database where
`datum_app` holds nothing at all.

The same two steps apply to a real recovery. Do not skip the second one.

### Drill log

Append a row every time. An empty table below means this section is a plan, not a control.

| date | dump | rows | `pg_restore` | wall clock | result |
|---|---|---|---|---|---|
| 2026-08-24 | synthetic: migrations 001–007 applied to `postgres:17`, 2 assertions, dumped and restored into `postgres:18` (no production data exists yet) | 2 | <1s | 3s | **PASS** — 32 checks, 0 failed |
| 2026-08-24 | negative control: dump of an empty database | 0 | <1s | 3s | **FAIL as intended** — 29 checks failed, exit 1 |

The second row matters as much as the first: a drill that cannot fail proves nothing.

---

## 6. Recovery objectives, honestly

v0 is **a single writer with no HA**, on purpose. One Postgres Machine, one volume, and an
accepted restart window. Add a replica when someone outside the organisation depends on this,
not before — the cost of running HA badly is worse than the cost of a known gap.

| scenario | what happens | recovery | objective |
|---|---|---|---|
| API Machine dies | Fly reschedules it; `min_machines_running = 1` and `auto_stop_machines = "off"` keep it up | none | seconds to a couple of minutes of 5xx |
| API deploy is bad | `fly releases rollback` | immediate | one deploy cycle |
| Postgres Machine restarts (host event, `fly deploy` of the db app) | writes fail for the restart window; reads fail too, there is no replica | none, it comes back | tens of seconds to a few minutes |
| Postgres process wedged | `fly machine restart -a datum-db` | manual | minutes |
| **volume lost** (single region, unreplicated) | everything since the last backup is gone | new volume, restore the newest dump, replay grants, re-point `DATABASE_URL` | **RPO ≤ 24h** with daily backups; **RTO = provisioning + measured restore time**, see below |
| accidental bad data | nothing was mutated — assertions are append-only. Supersede the row; the original stays readable as-of | in-product | immediate |

**RPO is a knob, not a fact.** Daily backups mean up to 24 hours of loss in the worst case.
Hourly is one flag on the scheduled Machine and the objection to it is storage cost, not
complexity. Choose deliberately and write the choice down here.

**RTO must be measured, not asserted.** It is: create app and volume (minutes) + the
`pg_restore` duration the drill prints + the grant replay (seconds) + `fly secrets set` and a
Machine restart (a minute). The drill prints both `restore duration` and `wall clock` every
run, precisely so this number comes from the drill log above rather than from optimism. The
figures logged today are for a near-empty database and will grow with the data; re-measure
after the first real corpus lands, and again whenever it grows by an order of magnitude.

**What is deliberately not solved in v0:** automatic failover, point-in-time recovery (no WAL
archiving — the dump granularity *is* the recovery granularity), and multi-region reads. All
three are cheap to add later and none of them are free to run badly now.

---

## 7. Cost

**Reconfirm every figure at deploy. These are quotes, not measurements**, and cloud pricing
changes without asking. Check `fly platform vm-sizes` and Fly's pricing page, then correct
this table.

| item | quoted rate | this deployment | note |
|---|---|---|---|
| always-on `shared-cpu-1x` 256 MB | ~$2.02/mo, ~$2.32 in `sjc` | — | the anchor everything else is scaled from |
| API Machine, `shared-cpu-1x` 512 MB | anchor + extra RAM | 1 Machine, always on | **estimate**; RAM above the 256 MB included with the preset is billed separately |
| DB Machine, `shared-cpu-1x` 1 GB | anchor + extra RAM | 1 Machine, always on | **estimate**; size this one first if anything needs headroom |
| volume | $0.15/GB-mo, **first 10 GB free** | 10 GB → $0 | billed even while the Machine is stopped |
| volume snapshots | $0.08/GB-mo | 14 days retention | **estimate**, depends on churn |
| object storage for dumps | provider's rate | outside the Fly org | Tigris, B2, R2, S3 — deliberately not Fly |
| shared IPv4 + TLS cert | free | 1 domain | a dedicated IPv4 is ~$2/mo and is not needed |
| **total** | | **low teens per month** | comfortably under Fly Managed Postgres' $38 floor, which is the whole point of running our own |

The comparison that justifies the operational burden: MPG's floor is $38/mo for Postgres
**16**, with version upgrades listed as not-yet-there. We pay roughly a quarter of that, run
the newest major, and own the backups. Owning the backups is the part that costs real
attention — which is what §4 and §5 are for.

---

## 8. The other deploy paths

### `docker compose up`

The path that must never break, because it survives any vendor's pricing change.

```bash
printf 'DATUM_ADMIN_PASSWORD=%s\nDATUM_SESSION_SECRET=%s\n' "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" > .env
docker compose up
```

There is no default admin password and no default session secret; compose refuses to start
until you supply your own. Postgres is not published to the host. `.env` is gitignored.

### Railway — and exactly what `railway.json` can and cannot do

**Verified against Railway's live schema (`https://railway.com/railway.schema.json`) and its
docs on 2026-08-24. Read this before assuming the file does more than it does.**

`railway.json` is **Config as Code**, and Railway has **deprecated** it in favour of
Infrastructure as Code (`.railway/railway.ts`). Existing files keep working for legacy
services until the hard cutoff on **2026-12-01**; new services cannot opt into it.

Its schema has `additionalProperties: false` at the top level and exactly three keys:
`build`, `deploy`, `environments`. Consequences, stated plainly rather than worked around:

- **It cannot declare a service.** It configures the one service that already points at this
  repo. The Postgres service is added in the dashboard (or via IaC).
- **It cannot declare variables**, so it cannot mark `DATUM_ADMIN_PASSWORD` as a required
  user input or `DATUM_SESSION_SECRET` as template-generated. Those live in Railway's
  **template** definition, which is authored in the dashboard, not in the repository. JSON has
  no comment syntax and the schema rejects unknown keys, so this limitation is documented here
  instead of in the file.

When creating the template, set these on the `datum` service:

| variable | template value | why |
|---|---|---|
| `DATUM_SESSION_SECRET` | `${{secret(64, "abcdef0123456789")}}` | 64 hex chars — the exact equivalent of `openssl rand -hex 32`, generated per deploy |
| `DATUM_ADMIN_PASSWORD` | *(required user input)* | plaintext is accepted precisely because a one-click platform cannot run a hashing command before boot; the server hashes it at startup, never persists it, and warns you to switch to a hash |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | reference to the Postgres service |
| `DATUM_ORG` | user input, default `local` | the scope root |

Railway also auto-suggests variables from `.env.example` when it detects the repository,
which is a second reason that file stays exhaustive and value-free.

If you would rather use the current mechanism, `railway config migrate --apply` converts this
file to `.railway/railway.ts`, where services, variables and volumes *can* be declared.

---

## 9. Runbook: symptom to cause

| symptom | first thing to check |
|---|---|
| server exits at boot with a message about credentials | working as designed. It refuses to boot without an admin credential and a session secret. There is no default password in the image |
| `DATUM_SESSION_SECRET must be at least 32 characters` | `openssl rand -hex 32`, not a passphrase |
| `/healthz` fails right after deploy | `fly logs -a datum`. Migrations run on boot and take an advisory lock; a concurrent boot waits rather than racing |
| every write is refused with `evidence_required` | invariant 1. `evidence.source` is mandatory and non-empty. This is not a bug |
| rows never leave `unverified` | the verification worker has no way to check the commit. Set `DATUM_GIT_MIRRORS` or `DATUM_GITHUB_TOKEN`. `unverified` is a normal state, and no `measured` gate will read it as satisfied |
| database unreachable from the API | `fly ips list -a datum-db` should be empty and `datum-db.internal` should resolve from the API Machine: `fly ssh console -a datum -C "getent hosts datum-db.internal"` |
| `libpq` TLS errors against the DB | do not append `sslmode=require`. 6PN is an encrypted WireGuard mesh and the stock image serves no certificate, so libpq's default `prefer` correctly falls back |
| Postgres will not start on a fresh volume | `PGDATA` must be a **subdirectory** of the mount (`/var/lib/postgresql/data/pgdata`); `initdb` refuses a directory containing `lost+found` |
| `migration X changed after it was applied` | an applied migration file was edited. Applied DDL is as immutable as a stored assertion: add a new migration |
| backup exits `dump is suspiciously small` | it refused to upload **and** refused to prune. Check the database before you trust anything |
| drill FAILs on `role/grant layer replayed` | the migrations on disk are newer than the dump. Expected when restoring an old backup with current code; the newer migrations apply on next boot |

---

## 10. Security posture

- **No secret values in this repository.** Ever. It is public. Secrets are set by name, via
  `fly secrets set` or the platform's variable UI. `.env` is gitignored; `.env.example` holds
  placeholders only.
- **The database has no public address.** Structurally, not by policy — see §1.
- **Nothing calls home.** No telemetry, no license check, no phone-home, no paid-feature
  flags. The only outbound host the server ever contacts is `api.github.com`, and only if you
  set `DATUM_GITHUB_TOKEN` for verification. An organisation running a truth store will read
  the network calls; there must be none to find.
- **Admin auth is a single shared password**, by explicit decision, to be replaced before
  this is exposed to anyone outside the organisation. Sessions are `HttpOnly`, `Secure`,
  `SameSite=Strict`, signed with a separate secret, 12 hours by default, and login is rate
  limited.
- **The image runs as a non-root user** and writes nothing to disk.
- **Nothing about any one organisation is hardcoded.** `DATUM_ORG` is configuration; the
  scope root is `org/${DATUM_ORG}`.
