import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { mintKey } from "../src/http/auth.js";
import {
  activePreferences,
  feedbackSignature,
  promotePreferences,
  recordFeedback,
  registerPreferenceRoutes,
  rejectionSignature,
  REJECTION_PREDICATE,
  type FeedbackRecord,
  type PreferenceRow,
} from "../src/preferences/index.js";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";

/**
 * Preference learning, against a real Postgres.
 *
 * Nothing here is stubbed. Every claim being tested is a claim about a database — a partial unique
 * index, a tier CHECK, an append-only trigger, a grant — so a fake would test nothing at all.
 *
 * The audit that motivates this file: 10,134 mem0 production entries, 97.8% junk, including 808
 * copies of one hallucinated "User prefers Vim" manufactured by a recall-to-re-extraction loop. Each
 * test below names the specific failure it makes impossible.
 */

const ORG = "acme";
const ROOT = `org/${ORG}`;
const PROJ = `${ROOT}/proj/engine`;

let pg: TestPostgres;
let db: Db;
let config: Config;
let app: FastifyInstance;
let key: string;

interface Feedback {
  scope?: string;
  actor: string;
  subject: string;
  predicate?: string;
  correction?: Record<string, unknown>;
  occasion: string;
}

const say = (f: Feedback) =>
  recordFeedback(db, {
    scope: f.scope ?? PROJ,
    actor: f.actor,
    subject: f.subject,
    predicate: f.predicate ?? "formatting",
    correction: f.correction ?? { statement: "use tabs, not spaces" },
    occasion: f.occasion,
  });

const sigFor = (subject: string, correction: Record<string, unknown> = { statement: "use tabs, not spaces" }) =>
  feedbackSignature({ subject, predicate: "formatting", correction });

async function prefRows(signature: string): Promise<PreferenceRow[]> {
  const { rows } = await db.query<PreferenceRow>(
    "app",
    `SELECT id, scope, signature, subject, predicate, statement, tier, occasions, distinct_humans,
            first_seen, last_seen, evidence_events, assertion_id, status, supersedes, superseded_by,
            created_at
       FROM datum.preferences WHERE signature = $1 ORDER BY created_at`,
    [signature],
  );
  return rows;
}

async function liveAssertions(signature: string) {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    binding: boolean;
    confidence: string;
    claim: string | null;
    evidence: Record<string, unknown>;
    supersedes: string | null;
  }>(
    "app",
    `SELECT id, kind, binding, confidence, claim, evidence, supersedes
       FROM datum.assertions
      WHERE subject = $1 AND predicate = 'prefers' AND superseded_by IS NULL`,
    [`preference:${signature}`],
  );
  return rows;
}

const post = (url: string, body: unknown, bearer = key) =>
  app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: body as Record<string, unknown>,
  });

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("datum_preferences");
  config = loadConfig({
    DATABASE_URL: pg.url("datum_preferences"),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "preferences-test",
    DATUM_SESSION_SECRET: "3".repeat(64),
  });

  app = Fastify({ logger: false });
  registerPreferenceRoutes(app, { db, config });
  await app.ready();

  key = (
    await mintKey(db, {
      label: "prefs",
      scope: ROOT,
      permissions: ["read", "assert", "supersede"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pg?.stop();
});

describe("one occurrence is an event, not a pattern", () => {
  it("promotes nothing from a single report", async () => {
    const subject = "engine/one-report";
    const recorded = await say({ actor: "human:alice", subject, occasion: "sess-solo" });
    expect(recorded.created).toBe(true);
    expect(recorded.occasions).toBe(1);
    expect(recorded.distinctHumans).toBe(1);

    await promotePreferences(db);

    // `preference_requires_repetition` would refuse the row anyway; the promoter must never get
    // that far. One person mentioning something once is the single largest source of junk in a
    // preference store, and it is filtered by arithmetic rather than by judgement.
    expect(await prefRows(sigFor(subject))).toEqual([]);
    expect(await liveAssertions(sigFor(subject))).toEqual([]);
  });
});

describe("the 808-duplicates test", () => {
  it("records ONE event when the same human says the same thing five times in one occasion", async () => {
    const subject = "engine/eight-oh-eight";
    const results: FeedbackRecord[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(await say({ actor: "human:alice", subject, occasion: "sess-repeat" }));
    }

    expect(results.map((r) => r.created)).toEqual([true, false, false, false, false]);
    // Every call reports the same count, because the count never moved.
    expect(results.map((r) => r.occasions)).toEqual([1, 1, 1, 1, 1]);
    // And all five calls resolve to the same event id: the first one.
    expect(new Set(results.map((r) => r.id)).size).toBe(1);

    const { rows } = await db.query<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.feedback_events WHERE signature = $1`,
      [sigFor(subject)],
    );
    // mem0's 808 copies came from re-processing the same source. `UNIQUE (actor, signature,
    // occasion)` makes that arithmetically impossible, not merely discouraged.
    expect(rows[0]?.n).toBe("1");

    await promotePreferences(db);
    expect(await prefRows(sigFor(subject))).toEqual([]);
  });
});

describe("the tier ladder — corroboration raises the scope of authority", () => {
  const subject = "engine/ladder";
  const signature = sigFor(subject);

  it("a second occasion from the same human earns a personal preference", async () => {
    await say({ actor: "human:alice", subject, occasion: "sess-1" });
    await say({ actor: "human:alice", subject, occasion: "sess-2" });

    const promoted = await promotePreferences(db);
    const mine = promoted.filter((p) => p.signature === signature);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.tier).toBe("personal");
    expect(mine[0]?.previous_tier).toBeNull();
    expect(mine[0]?.occasions).toBe(2);
    expect(mine[0]?.distinct_humans).toBe(1);
    expect(mine[0]?.binding).toBe(false);

    const rows = await prefRows(signature);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe("personal");
    expect(rows[0]?.occasions).toBe(2);
    expect(rows[0]?.superseded_by).toBeNull();

    // One person's preference is guidance, not a rule the org enforces.
    const live = await liveAssertions(signature);
    expect(live).toHaveLength(1);
    expect(live[0]?.kind).toBe("rule");
    expect(live[0]?.confidence).toBe("confirmed-by-human");
    expect(live[0]?.binding).toBe(false);
  });

  it("a second distinct human supersedes it to team, and the old row survives", async () => {
    const before = (await prefRows(signature))[0];
    await say({ actor: "human:bob", subject, occasion: "sess-3" });

    const promoted = (await promotePreferences(db)).filter((p) => p.signature === signature);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.previous_tier).toBe("personal");
    expect(promoted[0]?.tier).toBe("team");
    expect(promoted[0]?.supersedes).toBe(before?.id);
    expect(promoted[0]?.binding).toBe(false);

    const rows = await prefRows(signature);
    expect(rows).toHaveLength(2);
    // Superseded, NOT deleted. "When did this become a team preference?" has to stay answerable.
    const old = rows.find((r) => r.id === before?.id);
    expect(old).toBeDefined();
    expect(old?.tier).toBe("personal");
    expect(old?.superseded_by).toBe(promoted[0]?.preference_id);

    const live = rows.filter((r) => r.superseded_by === null && r.status === "active");
    expect(live).toHaveLength(1);
    expect(live[0]?.tier).toBe("team");
    expect(live[0]?.distinct_humans).toBe(2);
  });

  it("a third distinct human makes it an org rule, and binding", async () => {
    await say({ actor: "human:carol", subject, occasion: "sess-4" });

    const promoted = (await promotePreferences(db)).filter((p) => p.signature === signature);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.previous_tier).toBe("team");
    expect(promoted[0]?.tier).toBe("org");
    // A preference several people independently hold is a rule; one person's is guidance.
    expect(promoted[0]?.binding).toBe(true);

    const live = (await prefRows(signature)).filter((r) => r.superseded_by === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.tier).toBe("org");
    expect(live[0]?.distinct_humans).toBe(3);
    expect(live[0]?.occasions).toBe(4);

    const assertions = await liveAssertions(signature);
    expect(assertions).toHaveLength(1);
    expect(assertions[0]?.binding).toBe(true);
  });

  it("reconstructs the whole tier history by walking supersedes", async () => {
    const rows = await prefRows(signature);
    const byId: Record<string, PreferenceRow> = {};
    for (const r of rows) byId[r.id] = r;

    let head = rows.find((r) => r.superseded_by === null);
    const history: Array<{ tier: string; occasions: number; humans: number }> = [];
    while (head) {
      history.unshift({ tier: head.tier, occasions: head.occasions, humans: head.distinct_humans });
      head = head.supersedes ? byId[head.supersedes] : undefined;
    }

    // The question mem0 could not answer about any of its 808 rows.
    expect(history).toEqual([
      { tier: "personal", occasions: 2, humans: 1 },
      { tier: "team", occasions: 3, humans: 2 },
      { tier: "org", occasions: 4, humans: 3 },
    ]);
  });

  it("is idempotent: three more passes produce no second row", async () => {
    const before = await prefRows(signature);
    await promotePreferences(db);
    await promotePreferences(db);
    await promotePreferences(db);

    const after = await prefRows(signature);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.filter((r) => r.superseded_by === null && r.status === "active")).toHaveLength(1);
    expect(await liveAssertions(signature)).toHaveLength(1);
  });

  it("cites the event ids and names the actual humans in evidence.human", async () => {
    const live = (await liveAssertions(signature))[0];
    expect(live).toBeDefined();
    const evidence = live?.evidence as {
      human?: string;
      events?: string[];
      occasions?: string[];
      humans?: string[];
      source?: string;
    };

    // `human_evidence_names_a_human` requires this, and it must be the real actors rather than a
    // worker label: "someone told me" is not testimony.
    for (const who of ["human:alice", "human:bob", "human:carol"]) {
      expect(evidence.human).toContain(who);
    }
    expect(evidence.humans).toEqual(
      expect.arrayContaining(["human:alice", "human:bob", "human:carol"]),
    );

    const { rows: events } = await db.query<{ id: string }>(
      "app",
      `SELECT id FROM datum.feedback_events WHERE signature = $1 ORDER BY created_at`,
      [signature],
    );
    // Every promoted preference resolves back to the exact occasions that produced it.
    expect(evidence.events).toEqual(events.map((e) => e.id));
    expect(evidence.occasions).toEqual(["sess-1", "sess-2", "sess-3", "sess-4"]);
    for (const occasion of ["sess-1", "sess-4"]) expect(evidence.source).toContain(occasion);
  });
});

describe("nearest scope wins", () => {
  it("shadows an org preference with a project one carrying the same signature", async () => {
    const subject = "engine/scoped";
    const signature = sigFor(subject);

    for (const occasion of ["org-a", "org-b"]) {
      await say({ scope: ROOT, actor: "human:dana", subject, occasion });
    }
    for (const occasion of ["proj-a", "proj-b", "proj-c"]) {
      await say({ scope: PROJ, actor: "human:erin", subject, occasion });
    }
    await promotePreferences(db);

    const atProject = (await activePreferences(db, PROJ)).filter((p) => p.signature === signature);
    // One row, not two: the nearer scope wins outright rather than both being returned and the
    // caller left to guess. Scope is part of the key, so this raises no contradiction.
    expect(atProject).toHaveLength(1);
    expect(atProject[0]?.scope).toBe(PROJ);
    expect(atProject[0]?.distance).toBe(0);
    expect(atProject[0]?.occasions).toBe(3);

    const atOrg = (await activePreferences(db, ROOT)).filter((p) => p.signature === signature);
    expect(atOrg).toHaveLength(1);
    expect(atOrg[0]?.scope).toBe(ROOT);
    expect(atOrg[0]?.occasions).toBe(2);

    // The org row is still live and still reachable from the org scope; it was shadowed, not lost.
    const rows = await prefRows(signature);
    expect(rows.filter((r) => r.superseded_by === null)).toHaveLength(2);
  });
});

describe("the escape hatch", () => {
  const subject = "engine/wrong";
  const signature = sigFor(subject);
  let preferenceId = "";
  let assertionId = "";

  it("learns the preference first", async () => {
    await say({ actor: "human:alice", subject, occasion: "wrong-1" });
    await say({ actor: "human:bob", subject, occasion: "wrong-2" });
    const promoted = (await promotePreferences(db)).filter((p) => p.signature === signature);
    expect(promoted).toHaveLength(1);
    preferenceId = promoted[0]?.preference_id ?? "";
    assertionId = promoted[0]?.assertion_id ?? "";
    expect(promoted[0]?.tier).toBe("team");
  });

  it("refuses a rejection with no stated reason", async () => {
    const res = await post(`/v1/preferences/${preferenceId}/reject`, { actor: "human:jish" });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("malformed_request");
    expect(res.json().message).toContain("reason is required");
  });

  it("rejects it, retires the row and supersedes its assertion", async () => {
    const res = await post(`/v1/preferences/${preferenceId}/reject`, {
      actor: "human:jish",
      reason: "we moved to prettier; this rule was never ours",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected).toBe(true);

    const row = (await prefRows(signature)).find((r) => r.id === preferenceId);
    expect(row?.status).toBe("rejected");
    // Still there. A rejected preference is history, not an embarrassment to be deleted.
    expect(row?.superseded_by).toBeNull();

    const superseded = await db.one<{ superseded_by: string | null }>(
      "app",
      `SELECT superseded_by FROM datum.assertions WHERE id = $1`,
      [assertionId],
    );
    expect(superseded?.superseded_by).toBeTruthy();

    const live = await liveAssertions(signature);
    expect(live).toHaveLength(1);
    // A dead end carrying its own falsifier: the human's reason IS the falsifier.
    expect(live[0]?.kind).toBe("dead");
    expect(live[0]?.evidence.human).toBe("human:jish");
    expect(live[0]?.supersedes).toBe(assertionId);

    const stillDelivered = await activePreferences(db, PROJ);
    expect(stillDelivered.map((p) => p.signature)).not.toContain(signature);
  });

  it("is idempotent — rejecting twice writes nothing new", async () => {
    const events = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.feedback_events WHERE predicate = $1`,
      [REJECTION_PREDICATE],
    );
    const res = await post(`/v1/preferences/${preferenceId}/reject`, {
      actor: "human:jish",
      reason: "still wrong",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().already_rejected).toBe(true);
    const after = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.feedback_events WHERE predicate = $1`,
      [REJECTION_PREDICATE],
    );
    expect(after?.n).toBe(events?.n);
  });

  it("never re-promotes it, however many new matching events arrive", async () => {
    for (const actor of ["human:carol", "human:dana", "human:erin"]) {
      await say({ actor, subject, occasion: `wrong-after-${actor}` });
    }
    // Five distinct humans and five occasions: without the rejection this would be a binding org
    // rule. A wrong preference that the org has taken back must never become immortal.
    const promoted = (await promotePreferences(db)).filter((p) => p.signature === signature);
    expect(promoted).toEqual([]);

    const live = (await prefRows(signature)).filter(
      (r) => r.superseded_by === null && r.status === "active",
    );
    expect(live).toEqual([]);
    expect((await liveAssertions(signature))[0]?.kind).toBe("dead");
  });

  it("never promotes the rejection counter-events, however many humans reject the same row", async () => {
    // Several humans rejecting the same row is reachable: `UNIQUE (actor, signature, occasion)`
    // separates them by actor, so a race between two reject calls lands both. Written directly
    // rather than through the route because POST /v1/feedback refuses the reserved predicate —
    // that refusal is the other half of this guard, tested separately. `human:jish` already wrote
    // one of these by rejecting for real above, so these two make three.
    for (const actor of ["human:frank", "human:gita"]) {
      await recordFeedback(db, {
        scope: PROJ,
        actor,
        subject,
        predicate: REJECTION_PREDICATE,
        signature: rejectionSignature(preferenceId),
        correction: { rejected_preference: preferenceId, reason: "agreed, drop it" },
        occasion: `reject:${preferenceId}`,
      });
    }

    // Assert it really IS a candidate, so this test cannot pass vacuously. Three occasions from
    // three distinct humans: under any other predicate this would be a BINDING ORG RULE.
    const candidate = await db.one<{ occasions: number; distinct_humans: number; tier: string }>(
      "app",
      `SELECT occasions, distinct_humans, tier FROM datum.preference_candidates(2)
        WHERE signature = $1`,
      [rejectionSignature(preferenceId)],
    );
    expect(candidate).toMatchObject({ occasions: 3, distinct_humans: 3, tier: "org" });

    // And the promoter refuses it anyway. Otherwise humans rejecting one wrong preference would
    // corroborate each other into a rule of their own: the same loop, from the other side.
    await promotePreferences(db);
    const { rows } = await db.query<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.preferences WHERE predicate = $1 OR signature = $2`,
      [REJECTION_PREDICATE, rejectionSignature(preferenceId)],
    );
    expect(rows[0]?.n).toBe("0");
  });
});

describe("the routes", () => {
  it("answers 401 before 400, so a stranger cannot probe the schema", async () => {
    // Authenticate, THEN validate, THEN scope-check. The garbage body would fail validation, and
    // an unauthenticated caller must never learn that.
    const anon = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      headers: { "content-type": "application/json" },
      payload: { nonsense: true },
    });
    expect(anon.statusCode).toBe(401);
    expect(anon.json().reason).toBe("unauthorized");

    const anonGet = await app.inject({ method: "GET", url: "/v1/preferences" });
    expect(anonGet.statusCode).toBe(401);

    const anonReject = await app.inject({
      method: "POST",
      url: "/v1/preferences/pref_whatever/reject",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(anonReject.statusCode).toBe(401);
  });

  it("refuses a scope outside the key's subtree, after validating", async () => {
    const narrow = (
      await mintKey(db, {
        label: "narrow",
        scope: `${ROOT}/proj/other`,
        permissions: ["read", "assert"],
        expiresAt: null,
        createdBy: "test",
      })
    ).secret;
    const res = await post(
      "/v1/feedback",
      {
        scope: PROJ,
        actor: "human:alice",
        subject: "engine/route",
        predicate: "formatting",
        correction: { statement: "use tabs" },
        occasion: "route-1",
      },
      narrow,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe("forbidden");
  });

  it("records feedback once per occasion over HTTP and reports the running count", async () => {
    const body = {
      scope: PROJ,
      actor: "human:alice",
      subject: "engine/route",
      predicate: "formatting",
      correction: { statement: "wrap at 100, not 80" },
      occasion: "route-1",
    };
    const first = await post("/v1/feedback", body);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ created: true, occasions: 1, distinct_humans: 1 });
    expect(first.json().note).toContain("one occasion is an event, not a pattern");

    const again = await post("/v1/feedback", body);
    expect(again.statusCode).toBe(200);
    expect(again.json().created).toBe(false);
    expect(again.json().occasions).toBe(1);

    const second = await post("/v1/feedback", { ...body, occasion: "route-2" });
    expect(second.json()).toMatchObject({ created: true, occasions: 2 });
  });

  it("refuses the reserved rejection predicate", async () => {
    const res = await post("/v1/feedback", {
      scope: PROJ,
      actor: "human:alice",
      subject: "engine/reserved",
      predicate: REJECTION_PREDICATE,
      correction: { statement: "sneak a rejection in" },
      occasion: "reserved-1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("reserved");
  });

  it("serves active preferences with tier, counts and their citations", async () => {
    await promotePreferences(db);
    const res = await app.inject({
      method: "GET",
      url: `/v1/preferences?scope=${PROJ}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);

    const preferences = res.json().preferences as Array<{
      signature: string;
      tier: string;
      occasions: number;
      distinct_humans: number;
      binding: boolean;
      citation: { human: string; events: string[] } | null;
      statement: string;
    }>;
    expect(preferences.length).toBeGreaterThan(0);
    for (const p of preferences) {
      expect(["personal", "team", "org"]).toContain(p.tier);
      expect(p.occasions).toBeGreaterThanOrEqual(2);
      expect(p.binding).toBe(p.tier === "org");
      expect(p.citation?.human).toBeTruthy();
      expect(p.citation?.events.length).toBeGreaterThanOrEqual(2);
    }
    // Nearest-first, so the delivery path can take the first N and be right about the order.
    const distances = (res.json().preferences as Array<{ distance: number }>).map((p) => p.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    // The rejected one is gone from delivery while remaining on the record.
    expect(preferences.map((p) => p.signature)).not.toContain(sigFor("engine/wrong"));
  });

  it("404s an unknown preference", async () => {
    const res = await post("/v1/preferences/pref_nope/reject", {
      actor: "human:jish",
      reason: "nope",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().reason).toBe("not_found");
  });
});

describe("the signature is exact, never fuzzy", () => {
  it("collides on trivial phrasing differences and nothing more", async () => {
    const base = { subject: "Engine/Case", predicate: "Formatting" };
    const one = feedbackSignature({ ...base, correction: { statement: "Use  Tabs\n" } });
    const two = feedbackSignature({
      subject: "engine/case",
      predicate: "formatting",
      correction: { statement: "use tabs" },
    });
    expect(one).toBe(two);

    // Key order and nesting are canonicalised; a genuinely different correction is not.
    expect(feedbackSignature({ ...base, correction: { a: 1, b: 2 } })).toBe(
      feedbackSignature({ ...base, correction: { b: 2, a: 1 } }),
    );
    expect(feedbackSignature({ ...base, correction: { statement: "use spaces" } })).not.toBe(one);
    // Order is meaning in a list.
    expect(feedbackSignature({ ...base, correction: { at: ["a", "b"] } })).not.toBe(
      feedbackSignature({ ...base, correction: { at: ["b", "a"] } }),
    );
    // The separator cannot be smuggled across a field boundary.
    expect(
      feedbackSignature({ subject: "a|b", predicate: "c", correction: {} }),
    ).not.toBe(feedbackSignature({ subject: "a", predicate: "b|c", correction: {} }));
  });

  it("counts two humans as two, and never as three", async () => {
    const subject = "engine/no-invention";
    await say({ actor: "human:alice", subject, occasion: "n-1" });
    await say({ actor: "human:alice", subject, occasion: "n-2" });
    // Phrased differently by the same person; the same correction, so the same signature.
    const restated = await recordFeedback(db, {
      scope: PROJ,
      actor: "human:bob",
      subject: subject.toUpperCase(),
      predicate: "FORMATTING",
      correction: { statement: "Use Tabs,  Not Spaces" },
      occasion: "n-3",
    });
    expect(restated.signature).toBe(sigFor(subject));
    expect(restated.distinctHumans).toBe(2);

    const promoted = (await promotePreferences(db)).filter((p) => p.signature === sigFor(subject));
    expect(promoted[0]?.tier).toBe("team");
    expect(promoted[0]?.humans).toEqual(["human:alice", "human:bob"]);
  });
});
