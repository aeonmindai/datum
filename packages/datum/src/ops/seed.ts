import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import { assertFact, createMission } from "../domain/store.js";
import { newId } from "../domain/identity.js";
import { CONFIDENCE_CLASSES, KINDS } from "../domain/types.js";

/**
 * Seed loader.
 *
 * A seed file may only contain what an agent could legitimately have written: nothing in it may
 * claim `measured`, because confidence is earned. Real measurements load as `unverified` carrying
 * their real repo and commit, so the verification worker can genuinely promote them — which makes
 * the seed a live demonstration of invariant 4 rather than a fixture that bypasses it.
 */

export const SEEDS_DIR = fileURLToPath(new URL("../../seeds/", import.meta.url));

const SeedAssertion = z.object({
  scope: z.string(),
  subject: z.string(),
  predicate: z.string(),
  object: z.record(z.string(), z.unknown()),
  claim: z.string().nullish(),
  kind: z.enum(KINDS),
  binding: z.boolean().optional(),
  confidence: z.enum(CONFIDENCE_CLASSES).optional(),
  evidence: z.object({ source: z.string().min(1) }).loose(),
  valid_from: z.string().optional(),
  valid_to: z.string().nullish(),
  asserted_by: z.string().optional(),
  why: z.string().nullish(),
  reopen_if: z.string().nullish(),
  /** A stable local name so another row in the same file can supersede this one. */
  ref: z.string().optional(),
  supersedes_ref: z.string().nullish(),
});

const SeedFile = z.object({
  org: z.string().optional(),
  note: z.string().optional(),
  scopes: z
    .array(z.object({ path: z.string(), kind: z.string().optional(), label: z.string().optional() }))
    .optional(),
  assertions: z.array(SeedAssertion),
  missions: z
    .array(
      z.object({
        scope: z.string(),
        statement: z.string(),
        state: z.enum(["proposed", "active", "blocked", "closed"]),
        gates: z.array(
          z.object({
            subject: z.string(),
            predicate: z.string(),
            op: z.enum([">=", "<=", ">", "<", "=", "!="]),
            target: z.union([z.number(), z.string(), z.boolean()]),
            requires_confidence: z.enum(CONFIDENCE_CLASSES),
            note: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
  nodes: z
    .array(
      z.object({
        kind: z.enum(["agent", "worktree", "branch", "repo", "webhook", "human", "service"]),
        scope: z.string(),
        label: z.string(),
        role: z.string().nullish(),
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

export interface SeedReport {
  file: string;
  scopes: number;
  assertions: number;
  skipped: Array<{ subject: string; predicate: string; reason: string }>;
  missions: number;
  nodes: number;
  byKind: Record<string, number>;
  byConfidence: Record<string, number>;
}

/** Order rows so a superseding row is always inserted after the row it supersedes. */
function topoSort(rows: z.output<typeof SeedAssertion>[]): z.output<typeof SeedAssertion>[] {
  const byRef: Record<string, z.output<typeof SeedAssertion>> = {};
  for (const r of rows) if (r.ref) byRef[r.ref] = r;
  const out: z.output<typeof SeedAssertion>[] = [];
  const done = new Set<z.output<typeof SeedAssertion>>();
  const visiting = new Set<string>();

  const visit = (row: z.output<typeof SeedAssertion>): void => {
    if (done.has(row)) return;
    const dep = row.supersedes_ref ? byRef[row.supersedes_ref] : undefined;
    if (dep && dep !== row) {
      if (row.ref && visiting.has(row.ref)) {
        throw new Error(`seed has a supersession cycle at ref "${row.ref}"`);
      }
      if (row.ref) visiting.add(row.ref);
      visit(dep);
      if (row.ref) visiting.delete(row.ref);
    }
    done.add(row);
    out.push(row);
  };

  for (const row of rows) visit(row);
  return out;
}

export async function loadSeed(
  db: Db,
  source: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<SeedReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const raw: unknown = JSON.parse(await readFile(source, "utf8"));
  const seed = SeedFile.parse(raw);

  for (const s of seed.scopes ?? []) {
    await db.query(
      "app",
      `INSERT INTO datum.scopes (path, kind, label, created_by) VALUES ($1,$2,$3,'datum seed')
       ON CONFLICT (path) DO NOTHING`,
      [s.path, s.kind ?? "custom", s.label ?? null],
    );
  }

  const report: SeedReport = {
    file: source,
    scopes: seed.scopes?.length ?? 0,
    assertions: 0,
    skipped: [],
    missions: 0,
    nodes: 0,
    byKind: {},
    byConfidence: {},
  };

  const idByRef: Record<string, string> = {};
  for (const row of topoSort(seed.assertions)) {
    const supersedes = row.supersedes_ref ? idByRef[row.supersedes_ref] : null;
    if (row.supersedes_ref && !supersedes) {
      report.skipped.push({
        subject: row.subject,
        predicate: row.predicate,
        reason: `supersedes_ref "${row.supersedes_ref}" was not loaded`,
      });
      continue;
    }
    try {
      const result = await assertFact(
        db,
        {
          scope: row.scope,
          subject: row.subject,
          predicate: row.predicate,
          object: row.object,
          claim: row.claim ?? null,
          kind: row.kind,
          binding: row.binding ?? false,
          confidence: row.confidence ?? "unverified",
          evidence: row.evidence,
          valid_from: row.valid_from,
          valid_to: row.valid_to ?? null,
          asserted_by: row.asserted_by ?? "agent:seed",
          supersedes: supersedes ?? null,
          why: row.why ?? null,
          reopen_if: row.reopen_if ?? null,
          causality: newId("evt"),
        },
        { role: "app" },
      );
      if (row.ref) idByRef[row.ref] = result.assertion.id;
      report.assertions += 1;
      report.byKind[row.kind] = (report.byKind[row.kind] ?? 0) + 1;
      const conf = row.confidence ?? "unverified";
      report.byConfidence[conf] = (report.byConfidence[conf] ?? 0) + 1;
    } catch (err) {
      // A seed that cannot load is a seed that violates an invariant, and saying which one is
      // more useful than aborting the whole load.
      const reason =
        typeof err === "object" && err && "reason" in err
          ? String(err.reason)
          : (err as Error).message;
      report.skipped.push({ subject: row.subject, predicate: row.predicate, reason });
      log(`[seed] refused ${row.subject}.${row.predicate}: ${reason}`);
    }
  }

  for (const m of seed.missions ?? []) {
    try {
      await createMission(db, { ...m, asserted_by: "agent:seed" });
      report.missions += 1;
    } catch (err) {
      log(`[seed] mission refused: ${(err as Error).message}`);
    }
  }

  for (const n of seed.nodes ?? []) {
    // Same upsert the registration route uses. A seed that cannot be re-run is not a seed, and
    // two seed files naming the same human previously aborted the second one partway through -
    // after its assertions and missions had already landed, which is the worst possible place
    // to stop. Node identity is (kind, scope, label), so re-announcing is a heartbeat.
    await db.query(
      "app",
      `INSERT INTO datum.nodes (id, kind, scope, label, role, meta, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, now())
       ON CONFLICT (kind, scope, label) WHERE retired_at IS NULL DO UPDATE
          SET last_seen = now(), role = excluded.role, meta = excluded.meta`,
      [newId("n"), n.kind, n.scope, n.label, n.role ?? null, JSON.stringify(n.meta ?? {})],
    );
    report.nodes += 1;
  }

  return report;
}
