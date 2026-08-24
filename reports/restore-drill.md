# Restore drill — executed

A backup you have never restored is not a backup, and by this project's own doctrine an untested
backup is an unverified claim — exactly the kind of claim this store exists to refuse. So this file
is the record of a drill that actually ran, twice, end to end.

| field | value |
|---|---|
| executed | 2026-08-24T17:33:46Z |
| path exercised | **bucket** — `backup.sh` uploaded to a real S3 API, `restore-drill.sh` fetched the newest object back |
| object store | MinIO speaking the real S3 protocol (`aws s3` / `s3api head-object`), not a stand-in |
| encryption | `age` with a real recipient key; the drill decrypts with the identity file |
| source | a database seeded with `seeds/arc.json` — 66 assertions, 1 mission, 7 nodes, 3 scopes |
| dump | `pg_dump --format=custom --no-owner --no-privileges` → 79,463 bytes encrypted |
| restored into | a throwaway `postgres:18` container, fresh volume, random superuser password |
| command | `./scripts/restore-drill.sh --run-suite` (no `--file`: discovers the newest object) |
| result | **PASS — 43 checks passed, 0 failed, 0 skipped** |
| wall clock | 5s (fetch, decrypt, boot, restore, verify) |

## What was actually proven

1. **The bucket round trip works.** `backup.sh` dumped, encrypted, uploaded, verified the upload
   with `head-object`, and pruned by retention. `restore-drill.sh` then found the newest object
   by itself, downloaded it, decrypted it and restored it.
2. **The schema came back intact**, including the `no_two_live_contradictions` exclusion
   constraint **with its partial predicate**. That predicate is what keeps human testimony exempt;
   a restore that quietly lost it would turn advisory contradictions into blocking ones and
   destroy knowledge on the next write.
3. **The GRANT/REVOKE layer was replayed and then asserted.** This is the trap worth knowing:
   `pg_dump --no-privileges` does not carry ACLs, while `datum.schema_migrations` *is* in the
   dump — so `datum migrate` after a restore is a no-op and will not put the grants back.
   Recovery is restore **plus** grant replay. The drill replays from the migration files and only
   then checks that `datum_app` holds no `UPDATE`, `DELETE` or `TRUNCATE`; without the replay
   that check would pass vacuously on a database where `datum_app` holds nothing at all.
4. **All seven adversarial writes from deliverable 1 were replayed against the restored database**
   and behaved identically: six refused with the same reasons, one accepted. Each ran in its own
   scope so it could collide neither with the restored data nor with another case.
5. **Row counts were compared against the live source**, so a structurally valid but empty restore
   cannot pass.

## Two real bugs this drill found

Both would have turned a real recovery into an outage, and neither is visible without running it.

1. **`backup.sh` used the host's `pg_dump`**, which refuses outright when older than the server
   (`aborting because of server version mismatch`). That is the *normal* case here, not the
   exotic one: Datum self-hosts Postgres specifically to run the newest server, while a laptop or
   a distro image usually carries an older client. The script now asks the server its major
   version and borrows a matching `pg_dump` from the `postgres:<major>` image when the local
   client is behind, handling loopback and 6PN addresses differently because they need different
   container networking.
2. **`restore-drill.sh` could not read its own dump.** `docker cp` preserves the host file's
   mode and lands it owned by root, while `pg_restore` runs as the unprivileged `postgres` user
   — so a dump created under a restrictive umask, which is precisely what a careful operator does
   with an encrypted backup, failed with `could not open input file: Permission denied`. That
   reads like a corrupt dump rather than a permissions problem. Both copied files are now made
   readable explicitly after the copy.

## Verbatim output

```
[drill] finding the newest object under s3://datum-backups/datum/
[drill] newest: datum/2026/08/24/datum-20260824T172950Z.dump.age
[drill] input: /var/folders/tt/w77rv8ws2m70cd4t30j_sh8h0000gn/T//datum-drill.fFzO1m/datum-20260824T172950Z.dump.age (79463 bytes)
[drill] decrypting...
[drill] decrypted: 79247 bytes
[drill] starting throwaway postgres:18 as datum-restore-drill-95588
[drill] ready: Postgres 18.6 (Debian 18.6-1.pgdg13+2) on 127.0.0.1:55166
[drill] restoring...
[drill] pg_restore exited 0 after 0s
[drill] replayed 17 GRANT/REVOKE statements from the migrations (psql exited 0)

==== restore drill: checks against the RESTORED database ====================

  [32mPASS[0m  pg_restore completed without error                       0s
  [32mPASS[0m  role/grant layer replayed                                17 statements
-- invariant 3: the contradiction constraint --------------------------------
  [32mPASS[0m  no_two_live_contradictions exists as an exclusion constraint 1
  [32mPASS[0m    ...and still restricted to measured/derived rows       t
  [32mPASS[0m  btree_gist extension restored                            1
-- invariant 2: append-only, enforced by grants -----------------------------
  [32mPASS[0m  datum_app has SELECT and INSERT on datum.assertions      t
  [32mPASS[0m  datum_app has NO UPDATE/DELETE/TRUNCATE on datum.assertions f
  [32mPASS[0m  datum_app has NO UPDATE/DELETE/TRUNCATE on datum.verifications f
  [32mPASS[0m  datum_app has NO UPDATE/DELETE/TRUNCATE on datum.missions f
-- triggers, derived from the migration files -------------------------------
  [32mPASS[0m  trigger trg_assertions_apply_supersession                1
  [32mPASS[0m  trigger trg_assertions_confidence_is_earned              1
  [32mPASS[0m  trigger trg_assertions_detect_contradictions             1
  [32mPASS[0m  trigger trg_assertions_no_mutate                         1
  [32mPASS[0m  trigger trg_assertions_no_truncate                       1
  [32mPASS[0m  trigger trg_close_contradictions_on_supersede            1
  [32mPASS[0m  trigger trg_missions_apply_supersession                  1
  [32mPASS[0m  trigger trg_missions_no_mutate                           1
-- the guarantees, exercised rather than inspected --------------------------
  [32mPASS[0m  UPDATE as datum_app is refused by the grant system       refused: permission denied for table assertions
  [32mPASS[0m  TRUNCATE as the table owner is refused by the trigger    refused: assertions are append-only: TRUNCATE is never permitted
  [32mPASS[0m  UPDATE as the table owner is refused by the trigger      refused: assertions are immutable: UPDATE may only stamp supersession (id
  [32mPASS[0m  DELETE as the table owner is refused by the trigger      refused: assertions are append-only: DELETE is never permitted (id=a_01M0
-- tables and row counts ----------------------------------------------------
  [32mPASS[0m  datum.api_keys restored                                  0 rows
  [32mPASS[0m  datum.assertions restored                                66 rows
  [32mPASS[0m  datum.contradictions restored                            2 rows
  [32mPASS[0m  datum.missions restored                                  1 rows
  [32mPASS[0m  datum.nodes restored                                     7 rows
  [32mPASS[0m  datum.outbox restored                                    66 rows
  [32mPASS[0m  datum.rejections restored                                0 rows
  [32mPASS[0m  datum.schema_migrations restored                         7 rows
  [32mPASS[0m  datum.scopes restored                                    3 rows
  [32mPASS[0m  datum.verifications restored                             0 rows
  [32mPASS[0m  the restored database knows its schema history           7 migrations recorded
-- comparison against the live source --------------------------------------
  [32mPASS[0m  datum.api_keys matches source                            0
  [32mPASS[0m  datum.assertions matches source                          66
  [32mPASS[0m  datum.contradictions matches source                      2
  [32mPASS[0m  datum.missions matches source                            1
  [32mPASS[0m  datum.nodes matches source                               7
  [32mPASS[0m  datum.outbox matches source                              66
  [32mPASS[0m  datum.rejections matches source                          0
  [32mPASS[0m  datum.schema_migrations matches source                   7
  [32mPASS[0m  datum.scopes matches source                              3
  [32mPASS[0m  datum.verifications matches source                       0
-- the seven adversarial writes, against the restored database ---------------

 RUN  v4.1.11 /Users/jish/Documents/GitHub/datum/packages/datum

 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > has the exclusion constraint, with its partial predicate intact 9ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > still withholds UPDATE, DELETE and TRUNCATE from every runtime role 2ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 1 — no evidence — is still rejected 11ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 2 — UPDATE / DELETE — is still rejected 12ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 3 — two `measured` rows contradicting on the same scope/subject/predicate/period — is still rejected 10ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 4 — kind='failed' without reopen_if — is still rejected 2ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 5 — asserting `measured` directly — is still rejected 6ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 6 — superseding an already-superseded row — is still rejected 6ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 7 — ACCEPTED: a `confirmed-by-human` row contradicting a live `measured` row — is still accepted 8ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  18:33:22
   Duration  176ms (transform 30ms, setup 0ms, import 52ms, tests 65ms, environment 0ms)

  [32mPASS[0m  seven invariant cases on the RESTORED database           

============================================================================
restore duration : 0s (pg_restore only)
wall clock       : 5s (fetch, decrypt, boot, restore, verify)
postgres         : 18.6 (Debian 18.6-1.pgdg13+2) (postgres:18)
dump             : /var/folders/tt/w77rv8ws2m70cd4t30j_sh8h0000gn/T//datum-drill.fFzO1m/datum-20260824T172950Z.dump.age
checks           : 43 passed, 0 failed, 0 skipped
============================================================================

RESULT: PASS — the backup restores and the invariants hold on the restored database.
Record the date, the object key and the wall-clock duration in docs/OPERATIONS.md.

```
