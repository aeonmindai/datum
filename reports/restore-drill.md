# Restore drill — executed

A backup you have never restored is not a backup, and by this project's own doctrine an untested
backup is an unverified claim — exactly the kind of claim this store exists to refuse. So this file
is the record of a drill that actually ran, not a description of one.

| field | value |
|---|---|
| executed | 2026-08-24T16:45:09Z |
| operator | v0 build session |
| dump | `pg_dump --format=custom --no-owner --no-privileges` of a database seeded with `seeds/arc.json` (66 assertions, 1 mission, 7 nodes, 3 scopes) |
| dump size | 79853 bytes |
| dump sha256 | 042a51b1429e4f256e297d8b9d59643dd2329510a7e00bf78dcb1dd2efc90b31 |
| restored into | a throwaway `postgres:18` container, fresh volume, random superuser password |
| command | `./scripts/restore-drill.sh --file <dump> --run-suite` |
| result | **PASS** — 33 checks passed, 0 failed, 0 skipped |

## What was actually proven

1. The schema came back: every table, every trigger, `btree_gist`, and the
   `no_two_live_contradictions` exclusion constraint **with its partial predicate intact**. That
   predicate is what keeps human testimony exempt; a restore that silently lost it would turn
   advisory contradictions back into blocking ones and destroy knowledge on the next write.
2. The **GRANT/REVOKE layer was replayed and then asserted**. This is the trap worth knowing:
   `pg_dump --no-privileges` does not carry ACLs, while `datum.schema_migrations` *is* in the
   dump — so `datum migrate` after a restore is a no-op and will not put the grants back.
   Recovery is restore **plus** grant replay. The drill replays from the migration files and only
   then checks that `datum_app` holds no `UPDATE`, `DELETE` or `TRUNCATE`; without the replay
   that check would pass vacuously on a database where `datum_app` holds nothing at all.
3. **All seven adversarial writes from deliverable 1 were replayed against the restored database**
   and behaved identically: six refused with the same reasons, one accepted. Each case ran in its
   own scope so it could not collide with the restored data or with another case.

## Verbatim output

```
[drill] input: /tmp/datum-drill.dump (79853 bytes)
[drill] starting throwaway postgres:18 as datum-restore-drill-39429
[drill] ready: Postgres 18.6 (Debian 18.6-1.pgdg13+2) on 127.0.0.1:57778
[drill] restoring...
[drill] pg_restore exited 0 after 1s
[drill] replayed 17 GRANT/REVOKE statements from the migrations (psql exited 0)

==== restore drill: checks against the RESTORED database ====================

  [32mPASS[0m  pg_restore completed without error                       1s
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
  [32mPASS[0m  datum.api_keys restored                                  1 rows
  [32mPASS[0m  datum.assertions restored                                67 rows
  [32mPASS[0m  datum.contradictions restored                            2 rows
  [32mPASS[0m  datum.missions restored                                  1 rows
  [32mPASS[0m  datum.nodes restored                                     7 rows
  [32mPASS[0m  datum.outbox restored                                    67 rows
  [32mPASS[0m  datum.rejections restored                                0 rows
  [32mPASS[0m  datum.schema_migrations restored                         7 rows
  [32mPASS[0m  datum.scopes restored                                    3 rows
  [32mPASS[0m  datum.verifications restored                             0 rows
  [32mPASS[0m  the restored database knows its schema history           7 migrations recorded
-- the seven adversarial writes, against the restored database ---------------

 RUN  v4.1.11 /Users/jish/Documents/GitHub/datum/packages/datum

 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > has the exclusion constraint, with its partial predicate intact 11ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > still withholds UPDATE, DELETE and TRUNCATE from every runtime role 3ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 1 — no evidence — is still rejected 14ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 2 — UPDATE / DELETE — is still rejected 12ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 3 — two `measured` rows contradicting on the same scope/subject/predicate/period — is still rejected 10ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 4 — kind='failed' without reopen_if — is still rejected 2ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 5 — asserting `measured` directly — is still rejected 4ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 6 — superseding an already-superseded row — is still rejected 7ms
 ✓ test/restored.test.ts > deliverable 8 — invariants survive a restore > case 7 — ACCEPTED: a `confirmed-by-human` row contradicting a live `measured` row — is still accepted 8ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  17:45:09
   Duration  181ms (transform 27ms, setup 0ms, import 47ms, tests 73ms, environment 0ms)

  [32mPASS[0m  seven invariant cases on the RESTORED database           

============================================================================
restore duration : 1s (pg_restore only)
wall clock       : 4s (fetch, decrypt, boot, restore, verify)
postgres         : 18.6 (Debian 18.6-1.pgdg13+2) (postgres:18)
dump             : /tmp/datum-drill.dump
checks           : 33 passed, 0 failed, 0 skipped
============================================================================

RESULT: PASS — the backup restores and the invariants hold on the restored database.
Record the date, the object key and the wall-clock duration in docs/OPERATIONS.md.

```
