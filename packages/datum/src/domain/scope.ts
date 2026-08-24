import type { Db, DbRole } from "../db/pool.js";

/**
 * Scopes and nearest-scope-wins.
 *
 * A read resolves the union along the path with the nearest scope winning ties. This is the
 * mechanism that makes "global facts" and "fits any given project" the same feature, and it
 * is the one nobody ships — every competitor treats projects as billing-isolation units.
 * `AGENTS.md` has the right instinct ("the closest file wins") implemented in the filesystem;
 * this does it in data.
 *
 * Nothing here knows what the configured root label is.
 */

export const KNOWLEDGE_MODE_PREDICATE = "knowledge_mode";
export const KNOWLEDGE_MODE_SUBJECT = "project";
export type KnowledgeMode = "global" | "isolated";

/** 'org/a/proj/b' -> ['org', 'org/a', 'org/a/proj', 'org/a/proj/b'] */
export function ancestors(scope: string): string[] {
  const labels = scope.split("/").filter((l) => l.length > 0);
  const out: string[] = [];
  for (let i = 1; i <= labels.length; i++) out.push(labels.slice(0, i).join("/"));
  return out;
}

export interface ResolvedChain {
  /** Nearest first. This is what every read is evaluated against. */
  chain: string[];
  mode: KnowledgeMode;
  /** The scope carrying the mode assertion, if one was found. */
  modeScope: string | null;
}

/**
 * Build the read chain for a scope.
 *
 * Default is `global`, because org-scope facts are curated by construction — someone
 * deliberately asserted at org level — and that inheritance is the whole compounding asset.
 * `isolated` is not about override: nearest-scope-wins already handles disagreement without
 * raising a contradiction, because scope is part of the exclusion key. Isolation is for the
 * narrower case where a project should not even *see* org knowledge.
 */
export async function resolveChain(
  db: Db,
  scope: string,
  role: DbRole = "app",
): Promise<ResolvedChain> {
  const path = ancestors(scope);
  const row = await db.one<{ scope: string; value: string }>(
    role,
    `SELECT a.scope, a.object->>'value' AS value
       FROM datum.assertions a
      WHERE a.superseded_by IS NULL
        AND a.subject   = $2
        AND a.predicate = $3
        AND a.scope     = ANY($1::text[])
      ORDER BY a.scope_depth DESC, a.asserted_at DESC
      LIMIT 1`,
    [path, KNOWLEDGE_MODE_SUBJECT, KNOWLEDGE_MODE_PREDICATE],
  );

  const mode: KnowledgeMode = row?.value === "isolated" ? "isolated" : "global";
  const nearestFirst = [...path].reverse();
  if (mode === "global" || !row) {
    return { chain: nearestFirst, mode, modeScope: row?.scope ?? null };
  }

  // Isolated: the chain stops at the scope that declared isolation. Ancestors above it are
  // not merely deprioritised, they are invisible.
  const cutoff = row.scope.split("/").length;
  return {
    chain: nearestFirst.filter((s) => s.split("/").length >= cutoff),
    mode,
    modeScope: row.scope,
  };
}

export function isDescendantOf(scope: string, root: string): boolean {
  return scope === root || scope.startsWith(`${root}/`);
}
