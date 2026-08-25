#!/usr/bin/env node
/**
 * One-off: retract the assertions a non-idempotent seed load duplicated.
 *
 * A second load of `seeds/datum.json` minted fresh `unverified` rows because `valid_from` is part
 * of the content hash and the seed had not pinned it. They sit live beside the `measured` rows
 * they duplicate, which invariant 3 permits — the exclusion constraint only fires between
 * `measured` and `derived` — so nothing is corrupt and no gate is affected. But they would be
 * refused promotion on every future verification pass, and a permanent refusal is noise that
 * trains an operator to ignore refusals.
 *
 * The retraction uses the mechanism the schema already has for a number that should stop being a
 * fact: supersede it with `kind='dead'`, which the default read excludes and an explicit
 * `kind='dead'` query can still audit. Nothing is edited and nothing is deleted.
 *
 * Safe to re-run: it only ever targets live `unverified` rows that have a live `measured` sibling
 * for the same scope/subject/predicate, and a retracted row is no longer live.
 */
import { loadConfig } from "../packages/datum/src/config.js";
import { Db } from "../packages/datum/src/db/pool.js";
import { assertFact } from "../packages/datum/src/domain/store.js";

const config = loadConfig();
const db = new Db(config.databaseUrl);

interface Stray {
  id: string;
  scope: string;
  subject: string;
  predicate: string;
  object: Record<string, unknown>;
  valid_from: string;
}

const { rows } = await db.query<Stray>(
  "app",
  `SELECT a.id, a.scope, a.subject, a.predicate, a.object, a.valid_from::text AS valid_from
     FROM datum.assertions a
    WHERE a.superseded_by IS NULL
      AND a.confidence = 'unverified'
      -- A retraction is itself a live unverified row, so without this the script retracts its
      -- own retraction on every run and builds an endless supersession chain. Found by running
      -- it twice, which is the only way this class of bug ever shows up.
      AND a.kind <> 'dead'
      AND EXISTS (
            SELECT 1 FROM datum.assertions m
             WHERE m.superseded_by IS NULL
               AND m.confidence = 'measured'
               AND m.scope = a.scope
               AND m.subject = a.subject
               AND m.predicate = a.predicate)
    ORDER BY a.asserted_at`,
);

if (rows.length === 0) {
  console.log("nothing to retract: no live unverified row shadows a live measured one");
} else {
  console.log(`retracting ${rows.length} duplicate row(s)`);
}

let retracted = 0;
for (const s of rows) {
  const result = await assertFact(db, {
    scope: s.scope,
    subject: s.subject,
    predicate: s.predicate,
    object: s.object,
    kind: "dead",
    claim: `Retracted: a duplicate of the measured row for ${s.subject}.${s.predicate}, created by a seed load that did not pin valid_from.`,
    evidence: {
      source: "scripts/retract-duplicate-load.mts",
      repo: "aeonmindai/datum",
      method: "operator retraction of a duplicate seed load",
      duplicate_of_valid_from: s.valid_from,
    },
    // Deliberately NOT `confirmed-by-human`. That class requires `evidence.human` to name a
    // person - the schema enforces it - and no person has looked at these rows. An agent
    // cleaning up its own mess is an unverified claim about the record, and labelling it
    // anything stronger would be the exact unearned confidence this store exists to refuse.
    confidence: "unverified",
    asserted_by: "agent:cleanup",
    supersedes: s.id,
    why: "The same measurement was already on record as measured. This row was minted by a non-idempotent load and would be refused promotion on every future pass.",
    // Bring it back if the value it carries is ever asserted again on its own merits.
    reopen_if: `a ${s.subject}.${s.predicate} measurement is taken again`,
  });
  if (result.created) retracted += 1;
  console.log(
    `  ${s.subject}.${s.predicate} @${s.valid_from} -> ${result.created ? "retracted" : "already retracted"}`,
  );
}

console.log(`\nretracted ${retracted} of ${rows.length}`);
await db.close();
