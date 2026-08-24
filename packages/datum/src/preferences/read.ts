import type { Db } from "../db/pool.js";
import { resolveChain } from "../domain/scope.js";
import type { Evidence } from "../domain/types.js";
import type { ActivePreference, PreferenceTier } from "./types.js";

/**
 * Reading live preferences for a scope, nearest-scope-first.
 *
 * This is what feeds proactive delivery — handing an agent the preferences before it makes the
 * mistake, which is the only thing that actually zeroes the repetition. A preference that arrives
 * after the correction has already been given has taught nobody anything.
 *
 * Because it sits on that path it has to be cheap: one query over the resolved chain, plus the chain
 * lookup itself. Nearest-scope-wins is then applied in memory over at most a handful of rows, which
 * is the same mechanism `resolveChain` gives every other read — a project preference shadows the
 * org's for the same signature without raising a contradiction, because scope is part of the key.
 */

interface Row {
  id: string;
  scope: string;
  signature: string;
  subject: string;
  predicate: string;
  statement: string;
  tier: PreferenceTier;
  occasions: number;
  distinct_humans: number;
  first_seen: string;
  last_seen: string;
  evidence_events: string[];
  assertion_id: string | null;
  supersedes: string | null;
  created_at: string;
  binding: boolean | null;
  citation: Evidence | null;
}

const LIVE_IN_CHAIN_SQL = `
  SELECT p.id, p.scope, p.signature, p.subject, p.predicate, p.statement, p.tier,
         p.occasions, p.distinct_humans, p.first_seen, p.last_seen, p.evidence_events,
         p.assertion_id, p.supersedes, p.created_at,
         a.binding, a.evidence AS citation
    FROM datum.preferences p
    LEFT JOIN datum.assertions a ON a.id = p.assertion_id
   WHERE p.status = 'active'
     AND p.superseded_by IS NULL
     AND p.scope = ANY($1::text[])`;

export async function activePreferences(db: Db, scope: string): Promise<ActivePreference[]> {
  const { chain } = await resolveChain(db, scope);
  const { rows } = await db.query<Row>("app", LIVE_IN_CHAIN_SQL, [chain]);

  // `chain` is nearest-first, so its index IS the distance, and the first row seen for a signature
  // is the winner. Resolving here rather than in SQL keeps this to one query and keeps the isolated
  // case correct: under `isolated` the chain is truncated, so scope depth is not the right ordering
  // — membership of the chain is.
  const distanceByScope: Record<string, number> = {};
  chain.forEach((s, i) => {
    distanceByScope[s] = i;
  });

  const nearest = new Map<string, ActivePreference>();
  for (const row of rows) {
    const distance = distanceByScope[row.scope];
    if (distance === undefined) continue;
    const held = nearest.get(row.signature);
    if (held && held.distance <= distance) continue;
    nearest.set(row.signature, {
      id: row.id,
      scope: row.scope,
      signature: row.signature,
      subject: row.subject,
      predicate: row.predicate,
      statement: row.statement,
      tier: row.tier,
      occasions: row.occasions,
      distinct_humans: row.distinct_humans,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      evidence_events: row.evidence_events,
      assertion_id: row.assertion_id,
      binding: row.binding ?? false,
      citation: row.citation,
      supersedes: row.supersedes,
      created_at: row.created_at,
      distance,
    });
  }

  // Nearest first, then binding org rules ahead of guidance, then most recently corroborated: the
  // order a caller should read them in if it only has room for the first few.
  return [...nearest.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      Number(b.binding) - Number(a.binding) ||
      (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0),
  );
}
