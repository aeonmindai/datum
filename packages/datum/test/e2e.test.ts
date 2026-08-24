import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { buildServer, type Server } from "../src/http/server.js";
import { runVerificationPass } from "../src/worker/verify.js";
import { mintKey } from "../src/http/auth.js";
import { DEFAULT_BUDGET_BYTES } from "../src/http/compact.js";

/**
 * Deliverables 2–5, end to end, against real Postgres and a real git repository.
 *
 * The verification worker is pointed at this very repo, so promotion to `measured` is decided by
 * an actual `git merge-base --is-ancestor` against actual commits. The refutation cases are the
 * ones that matter most: a commit that does not exist, and — the exact Arc failure mode — a real
 * commit whose evidence claims containment in a branch that does not contain it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ORG = "acme";
const ROOT = `org/${ORG}`;
const PROJ = `${ROOT}/proj/arc`;

const git = (args: string[]): string =>
  execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();

let pg: TestPostgres;
let db: Db;
let server: Server;
let app: FastifyInstance;
let config: Config;
let key: string;
let narrowKey: string;
let headCommit: string;
let currentBranch: string;
const sizes: Array<{ tool: string; bytes: number; text: string }> = [];

const EV = {
  source: "test/e2e.test.ts",
  instrument: "vitest",
};

async function post(path: string, body: unknown, bearer = key) {
  return app.inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: body as object,
  });
}

async function get(path: string, bearer = key) {
  return app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${bearer}` } });
}

async function mcp(method: string, params?: Record<string, unknown>, bearer = key) {
  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  return res.json() as { result?: Record<string, unknown>; error?: { message: string } };
}

function mcpText(res: { result?: Record<string, unknown> }): string {
  const content = res.result?.content;
  if (!Array.isArray(content)) throw new Error(`no content: ${JSON.stringify(res)}`);
  const first: unknown = content[0];
  if (!first || typeof first !== "object" || !("text" in first)) throw new Error("no text");
  return String(first.text);
}

beforeAll(async () => {
  headCommit = git(["rev-parse", "HEAD"]);
  currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

  pg = await startPostgres();
  db = await pg.fork("datum_e2e");
  await db.close();

  config = loadConfig({
    DATABASE_URL: pg.url("datum_e2e"),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
    DATUM_SESSION_SECRET: "0".repeat(64),
    DATUM_PUBLIC_URL: "http://localhost:8080",
    // The verification worker resolves commits against this repo, on disk. No network, no stub.
    DATUM_GIT_MIRRORS: `aeonmindai/datum=${REPO_ROOT}`,
  });

  server = await buildServer(config, { startWorker: false, log: false });
  app = server.app;
  db = server.db;

  key = (
    await mintKey(db, {
      label: "e2e",
      scope: ROOT,
      permissions: ["read", "assert", "supersede", "admin"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;
  narrowKey = (
    await mintKey(db, {
      label: "e2e-narrow",
      scope: `${ROOT}/proj/other`,
      permissions: ["read", "assert"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;
}, 240_000);

afterAll(async () => {
  await server?.close();
  await pg?.stop();
});

describe("deliverable 3 — /v1", () => {
  it("serves an unauthenticated /healthz carrying the scope root", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, org: ORG, scope_root: ROOT });
  });

  it("records a fact with evidence, as unverified, and says so", async () => {
    const res = await post("/v1/assert", {
      scope: PROJ,
      subject: "engine",
      predicate: "aggregate_tok_s_at_b256",
      object: { value: 757.5, unit: "tok/s" },
      claim: "aggregate throughput at B=256 on one H200",
      kind: "measured",
      evidence: {
        ...EV,
        repo: "aeonmindai/datum",
        commit: headCommit,
        contained_in: [currentBranch],
        protocol: "B=256, produced tokens only",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.assertion.confidence).toBe("unverified");
    expect(body.note).toContain("verification worker");
  });

  it("refuses a write with no evidence, and records the refusal", async () => {
    const res = await post("/v1/assert", {
      scope: PROJ,
      subject: "engine",
      predicate: "no_evidence_here",
      object: { value: 1 },
      kind: "measured",
      evidence: { source: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toBe("malformed_request");

    // And the same write with a syntactically present but semantically empty source is refused
    // by the database, with the invariant's own reason.
    const res2 = await post("/v1/assert", {
      scope: PROJ,
      subject: "engine",
      predicate: "no_evidence_here",
      object: { value: 1 },
      kind: "measured",
      evidence: { source: "   " },
    });
    expect(res2.statusCode).toBe(422);
    expect(res2.json()).toMatchObject({ ok: false, reason: "evidence_required", invariant: 1 });

    const logged = await db.one<{ n: string }>(
      "app",
      "SELECT count(*)::text AS n FROM datum.rejections WHERE reason = 'evidence_required'",
    );
    expect(Number(logged?.n)).toBeGreaterThan(0);
  });

  it("refuses a claimed `measured`, with the reason and the remedy", async () => {
    const res = await post("/v1/assert", {
      scope: PROJ,
      subject: "engine",
      predicate: "claimed_measured",
      object: { value: 14000 },
      kind: "measured",
      confidence: "measured",
      evidence: EV,
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toMatchObject({ reason: "confidence_is_earned", invariant: 4 });
    expect(body.hint).toContain("verification worker");
  });

  it("refuses kind=failed with no falsifier", async () => {
    const res = await post("/v1/assert", {
      scope: PROJ,
      subject: "ragged_pair",
      predicate: "decode_delta_pct",
      object: { value: -41 },
      kind: "failed",
      why: "regressed decode by 41% as shipped",
      evidence: EV,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe("failed_requires_reopen_if");
  });

  it("reads exact-first, and never returns a superseded row", async () => {
    const first = await post("/v1/assert", {
      scope: PROJ,
      subject: "bake",
      predicate: "seconds_per_layer",
      object: { value: 120, unit: "s/layer" },
      kind: "measured",
      evidence: EV,
    });
    const firstId = first.json().assertion.id;

    const corrected = await post("/v1/supersede", {
      supersedes: firstId,
      scope: PROJ,
      subject: "bake",
      predicate: "seconds_per_layer",
      object: { value: 82.7, unit: "s/layer" },
      kind: "measured",
      evidence: { ...EV, protocol: "qtip-family, post-codebook-work" },
    });
    expect(corrected.statusCode).toBe(201);

    const read = await get(`/v1/ask?scope=${PROJ}&subject=bake&predicate=seconds_per_layer`);
    const rows = read.json().assertions;
    expect(rows).toHaveLength(1);
    expect(rows[0].object.value).toBe(82.7);
    expect(rows.some((r: { id: string }) => r.id === firstId)).toBe(false);
  });

  it("answers as-of on the assert-time axis", async () => {
    const before = await get(`/v1/state?scope=${PROJ}`);
    const seqNow = before.json().sequence;

    const target = await post("/v1/assert", {
      scope: PROJ,
      subject: "asof_probe",
      predicate: "value",
      object: { value: "first" },
      kind: "state",
      evidence: EV,
    });
    const firstId = target.json().assertion.id;
    const firstSeq = Number(target.json().assertion.asserted_at);

    await post("/v1/supersede", {
      supersedes: firstId,
      scope: PROJ,
      subject: "asof_probe",
      predicate: "value",
      object: { value: "second" },
      kind: "state",
      evidence: EV,
    });

    const now = await get(`/v1/ask?scope=${PROJ}&subject=asof_probe`);
    expect(now.json().assertions[0].object.value).toBe("second");

    const asOf = await get(`/v1/ask?scope=${PROJ}&subject=asof_probe&as_of=${firstSeq}`);
    expect(asOf.json().assertions[0].object.value).toBe("first");

    // And before it was ever asserted, we believed nothing about it.
    const earlier = await get(`/v1/ask?scope=${PROJ}&subject=asof_probe&as_of=${seqNow}`);
    expect(earlier.json().assertions).toHaveLength(0);
  });

  it("binds a key to its scope subtree", async () => {
    const res = await get(`/v1/ask?scope=${PROJ}`, narrowKey);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "forbidden" });
    expect(res.json().detail.key_scope).toBe(`${ROOT}/proj/other`);
  });

  it("rejects an unknown key", async () => {
    const res = await get(`/v1/ask?scope=${PROJ}`, "dtm_live_definitely-not-a-key");
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe("unauthorized");
  });

  it("resolves nearest-scope-wins, and isolates without rewriting", async () => {
    await post("/v1/assert", {
      scope: ROOT,
      subject: "gpu",
      predicate: "cudnn_decode_delta_pct",
      object: { value: -62, unit: "%" },
      claim: "cudnn costs -62% on H200 decode",
      kind: "rule",
      binding: true,
      evidence: { ...EV, instrument: "measured session-4" },
    });

    // Inherited for free at project scope: that inheritance is the compounding asset.
    const inherited = await get(`/v1/ask?scope=${PROJ}&subject=gpu&predicate=cudnn_decode_delta_pct`);
    expect(inherited.json().assertions[0].scope).toBe(ROOT);

    // A project asserting its own value for the same subject and predicate wins locally, and
    // raises no contradiction, because scope is part of the exclusion key.
    await post("/v1/assert", {
      scope: PROJ,
      subject: "gpu",
      predicate: "cudnn_decode_delta_pct",
      object: { value: -12, unit: "%" },
      kind: "rule",
      evidence: { ...EV, instrument: "different box" },
    });
    const local = await get(`/v1/ask?scope=${PROJ}&subject=gpu&predicate=cudnn_decode_delta_pct`);
    expect(local.json().assertions).toHaveLength(1);
    expect(local.json().assertions[0].scope).toBe(PROJ);
    expect(local.json().assertions[0].object.value).toBe(-12);

    const conflicts = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.contradictions
        WHERE predicate = 'cudnn_decode_delta_pct'`,
    );
    expect(Number(conflicts?.n)).toBe(0);

    // Isolation is a superseding assertion, not a setting.
    const isolated = await post("/v1/mode", { scope: PROJ, mode: "isolated" });
    expect(isolated.statusCode).toBe(201);
    expect(isolated.json().chain).not.toContain(ROOT);

    const afterIsolation = await get(`/v1/ask?scope=${PROJ}&subject=gpu`);
    expect(afterIsolation.json().mode).toBe("isolated");
    expect(
      afterIsolation.json().assertions.every((r: { scope: string }) => r.scope !== ROOT),
    ).toBe(true);

    await post("/v1/mode", { scope: PROJ, mode: "global" });
    const back = await get(`/v1/ask?scope=${PROJ}&subject=gpu`);
    expect(back.json().mode).toBe("global");
  });
});

describe("deliverable 2 — the verification worker", () => {
  it("promotes a claim whose commit resolves and is contained where claimed", async () => {
    const before = await get(`/v1/ask?scope=${PROJ}&subject=engine&predicate=aggregate_tok_s_at_b256`);
    expect(before.json().assertions[0].confidence).toBe("unverified");
    const unverifiedId = before.json().assertions[0].id;
    const seqBefore = Number(before.json().assertions[0].asserted_at);

    const results = await runVerificationPass(db, config, { recheckMs: 0, limit: 100 });
    const promotion = results.find((r) => r.assertion_id === unverifiedId);
    expect(promotion?.outcome).toBe("confirmed");
    expect(promotion?.method).toBe("local-mirror");
    expect(promotion?.promoted_to).toBeTruthy();

    const after = await get(`/v1/ask?scope=${PROJ}&subject=engine&predicate=aggregate_tok_s_at_b256`);
    const row = after.json().assertions[0];
    expect(row.confidence).toBe("measured");
    expect(row.verification_id).toBeTruthy();
    expect(row.asserted_by).toBe(`worker:verification@${ORG}`);
    expect(row.supersedes).toBe(unverifiedId);

    // The promotion is a supersession, so the earlier belief is still reconstructable.
    const asOf = await get(
      `/v1/ask?scope=${PROJ}&subject=engine&predicate=aggregate_tok_s_at_b256&as_of=${seqBefore}`,
    );
    expect(asOf.json().assertions[0].confidence).toBe("unverified");

    // The outcome is itself an assertion.
    const outcome = await get(
      `/v1/ask?scope=${PROJ}&subject=assertion:${unverifiedId}&predicate=verification_outcome`,
    );
    expect(outcome.json().assertions[0].object.value).toBe("confirmed");
    expect(outcome.json().assertions[0].confidence).toBe("measured");
  });

  it("refuses to promote a commit that does not exist", async () => {
    const bogus = "0".repeat(40);
    const created = await post("/v1/assert", {
      scope: PROJ,
      subject: "phantom",
      predicate: "throughput",
      object: { value: 99999 },
      kind: "measured",
      evidence: { ...EV, repo: "aeonmindai/datum", commit: bogus, contained_in: ["main"] },
    });
    const id = created.json().assertion.id;

    const results = await runVerificationPass(db, config, { recheckMs: 0, limit: 100 });
    const outcome = results.find((r) => r.assertion_id === id);
    expect(outcome?.outcome).toBe("refuted");
    expect(outcome?.promoted_to).toBeNull();

    const row = await get(`/v1/ask?scope=${PROJ}&subject=phantom`);
    expect(row.json().assertions[0].confidence).toBe("unverified");
  });

  it("refuses to promote a real commit that is not contained where the evidence claims", async () => {
    // This is the exact hole that let "branch work quoted as shipped" survive three sessions on
    // Arc: the commit is genuine, and the containment claim is false.
    const created = await post("/v1/assert", {
      scope: PROJ,
      subject: "branch_work",
      predicate: "claimed_shipped",
      object: { value: true },
      kind: "state",
      evidence: {
        ...EV,
        repo: "aeonmindai/datum",
        commit: headCommit,
        contained_in: ["refs/heads/a-branch-that-does-not-exist"],
      },
    });
    const id = created.json().assertion.id;

    const results = await runVerificationPass(db, config, { recheckMs: 0, limit: 100 });
    const outcome = results.find((r) => r.assertion_id === id);
    expect(outcome?.outcome).toBe("refuted");
    expect(String(outcome?.detail.why)).toContain("not contained in");

    const why = await get(`/v1/why/${id}`);
    expect(why.json().assertion.confidence).toBe("unverified");
  });

  it("leaves a claim with no commit permanently unverified, and says why once", async () => {
    const created = await post("/v1/assert", {
      scope: PROJ,
      subject: "hearsay",
      predicate: "gsm8k_pct",
      object: { value: 96, unit: "%" },
      claim: "GSM8K 96% was reached",
      kind: "measured",
      confidence: "confirmed-by-human",
      evidence: {
        source: "direct statement",
        human: "Jish",
        protocol: "none on record; cannot be published until re-measured",
      },
    });
    const id = created.json().assertion.id;

    await runVerificationPass(db, config, { recheckMs: 0, limit: 100 });
    const row = await get(`/v1/why/${id}`);
    // It stays testimony. `confirmed-by-human` is never a candidate for promotion, and the
    // worker does not touch it.
    expect(row.json().assertion.confidence).toBe("confirmed-by-human");
    expect(row.json().verification).toBeNull();
  });

  it("says unresolvable, never refuted, when it cannot read the repo at all", async () => {
    // The distinction this defends: "we looked and it is not there" versus "we were not allowed
    // to look". GitHub answers 404 for a private repo exactly as it does for a missing one, so a
    // worker that conflates them marks true claims about private repos as actively false — which
    // is the store publishing a confident conclusion it cannot support.
    const created = await post("/v1/assert", {
      scope: PROJ,
      subject: "private_repo_claim",
      predicate: "throughput",
      object: { value: 1234 },
      kind: "measured",
      evidence: {
        ...EV,
        repo: "aeonmindai/definitely-private",
        commit: headCommit,
        contained_in: ["main"],
      },
    });
    const id = created.json().assertion.id;

    const unreadable = loadConfig({
      DATABASE_URL: pg.url("datum_e2e"),
      DATUM_ORG: ORG,
      DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
      DATUM_SESSION_SECRET: "0".repeat(64),
      // A mirror path that is not a git repository at all.
      DATUM_GIT_MIRRORS: `aeonmindai/definitely-private=${REPO_ROOT}/does-not-exist`,
    });
    const results = await runVerificationPass(db, unreadable, { recheckMs: 0, limit: 100 });
    const outcome = results.find((r) => r.assertion_id === id);
    expect(outcome?.outcome).toBe("unresolvable");
    expect(outcome?.promoted_to).toBeNull();
    expect(String(outcome?.detail.why)).toContain("not a readable git repository");

    const row = await get(`/v1/why/${id}`);
    expect(row.json().assertion.confidence).toBe("unverified");
  });
});

describe("deliverable 3 — contradictions are advisory across tiers", () => {
  it("accepts testimony against a measurement, contests both, and does not satisfy the gate", async () => {
    // The measured row here was promoted by the worker in the previous block.
    const human = await post("/v1/assert", {
      scope: PROJ,
      subject: "engine",
      predicate: "aggregate_tok_s_at_b256",
      object: { value: 16600, unit: "tok/s" },
      claim: "aggregate was 16,600",
      confidence: "confirmed-by-human",
      kind: "measured",
      evidence: { source: "a document nobody can find", human: "Anonymous" },
    });
    expect(human.statusCode).toBe(201);

    const read = await get(`/v1/ask?scope=${PROJ}&subject=engine&predicate=aggregate_tok_s_at_b256`);
    const rows = read.json().assertions;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { contested: boolean }) => r.contested)).toBe(true);
    expect(rows.map((r: { confidence: string }) => r.confidence).sort()).toEqual([
      "confirmed-by-human",
      "measured",
    ]);

    const queue = await get("/v1/contradictions");
    expect(queue.json().contradictions.length).toBeGreaterThan(0);

    const mission = await post("/v1/missions", {
      scope: PROJ,
      statement: "Bake DeepSeek-V4-Flash into K=9/V=4/L=12 and serve it.",
      state: "active",
      gates: [
        {
          subject: "engine",
          predicate: "aggregate_tok_s_at_b256",
          op: ">=",
          target: 14000,
          requires_confidence: "measured",
        },
        {
          subject: "gsm8k",
          predicate: "pct",
          op: ">=",
          target: 90,
          requires_confidence: "measured",
        },
      ],
    });
    expect(mission.statusCode).toBe(201);

    const missions = await get(`/v1/missions?scope=${PROJ}`);
    const gates = missions.json().missions[0].gates;
    // The human's 16,600 clears 14,000 and must NOT satisfy a gate demanding `measured`.
    expect(gates[0].reached).toBe(false);
    expect(gates[0].actual).toBe(757.5);
    expect(gates[0].confidence).toBe("measured");
    // And a gate with no evidence of the required class reads null, not false.
    expect(gates[1].reached).toBeNull();
    expect(gates[1].why_null).toContain("no live assertion");
  });

  it("refuses a mission that is active with nothing checkable attached", async () => {
    const res = await post("/v1/missions", {
      scope: PROJ,
      statement: "Be better",
      state: "active",
      gates: [],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toBe("active_mission_requires_gate");
  });
});

describe("deliverable 4 — /mcp is a facade, and it is quiet", () => {
  it("advertises six tools, not thirty", async () => {
    const res = await mcp("tools/list");
    const tools = res.result?.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ask",
      "assert",
      "nodes",
      "state",
      "supersede",
      "why",
    ]);
    // The tool list is itself a permanent context cost, so it gets a budget too.
    const listBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
    sizes.push({ tool: "tools/list (whole manifest)", bytes: listBytes, text: "" });
    expect(listBytes).toBeLessThan(6_000);
  });

  it("answers initialize even though the handshake was removed from the protocol", async () => {
    const res = await mcp("initialize", { protocolVersion: "2026-07-28" });
    expect(res.result?.protocolVersion).toBe("2026-07-28");
    expect(String(res.result?.instructions)).toContain("cannot assert `measured`");
  });

  it("keeps state, ask and nodes inside the byte budget and still carries provenance", async () => {
    for (const [tool, args] of [
      ["state", { scope: PROJ }],
      ["ask", { scope: PROJ, subject: "engine", predicate: "aggregate_tok_s_at_b256" }],
      ["nodes", { scope: PROJ }],
    ] as const) {
      const res = await mcp("tools/call", { name: tool, arguments: args });
      const text = mcpText(res);
      const bytes = Buffer.byteLength(text, "utf8");
      sizes.push({ tool, bytes, text });
      expect(bytes, `${tool} response was ${bytes} bytes:\n${text}`).toBeLessThanOrEqual(
        DEFAULT_BUDGET_BYTES + 120,
      );
    }

    const ask = mcpText(await mcp("tools/call", { name: "ask", arguments: { scope: PROJ, subject: "engine" } }));
    // A bare number cannot leave the system: the confidence class is on every line.
    expect(ask).toContain("measured");
    expect(ask).toContain("CONTESTED");
  });

  it("returns a refusal as readable tool content, not a transport error", async () => {
    const res = await mcp("tools/call", {
      name: "assert",
      arguments: {
        scope: PROJ,
        subject: "mcp_probe",
        predicate: "value",
        value: 1,
        kind: "measured",
        confidence: "measured",
        evidence: { source: "mcp test" },
      },
    });
    expect(res.result?.isError).toBe(true);
    const text = mcpText(res);
    expect(text).toContain("REFUSED confidence_is_earned");
    expect(text).toContain("verification worker");
  });

  it("writes through the facade and lands unverified", async () => {
    const res = await mcp("tools/call", {
      name: "assert",
      arguments: {
        scope: PROJ,
        subject: "mcp_probe",
        predicate: "value",
        value: 42,
        unit: "widgets",
        kind: "state",
        evidence: { source: "mcp test" },
      },
    });
    expect(res.result?.isError).toBe(false);
    expect(mcpText(res)).toContain("landed unverified");
  });

  it("serves RFC 9728 metadata that admits it is not an OAuth resource server", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorization_servers).toEqual([]);
    expect(res.json().datum_auth_note).toContain("bearer API keys");
  });
});

describe("deliverable 6 — the admin panel's backend", () => {
  it("refuses a wrong password, records the failure as an assertion, then rate-limits", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const recorded = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions
        WHERE subject = 'admin:login' AND predicate = 'failed_login'`,
    );
    expect(Number(recorded?.n)).toBeGreaterThan(0);

    for (let i = 0; i < 6; i++) {
      await app.inject({ method: "POST", url: "/admin/api/login", payload: { password: "wrong" } });
    }
    const limited = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "wrong" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().detail.retry_after_seconds).toBeGreaterThan(0);
  });

  it("requires a session for every panel route", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/api/keys" });
    expect(res.statusCode).toBe(401);
  });

  it("signs in, mints a key that is shown once, and revokes it", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "correct-horse-battery-staple" },
      // A fresh IP, because the previous test deliberately exhausted the default one.
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(login.statusCode).toBe(204);
    const cookie = login.cookies.find((c) => c.name === "datum_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite?.toLowerCase()).toBe("strict");

    const session = { cookie: `datum_session=${cookie!.value}` };

    const me = await app.inject({ method: "GET", url: "/admin/api/me", headers: session });
    expect(me.json()).toMatchObject({ authenticated: true, org: ORG, scope_root: ROOT });
    expect(me.json().verification).toMatchObject({ configured: true, method: "local-mirror" });

    const created = await app.inject({
      method: "POST",
      url: "/admin/api/keys",
      headers: { ...session, "content-type": "application/json" },
      payload: { label: "panel-minted", scope: PROJ, permissions: ["read", "assert"] },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret;
    expect(secret.startsWith("dtm_live_")).toBe(true);

    // The secret is never recoverable, only its hash is stored.
    const list = await app.inject({ method: "GET", url: "/admin/api/keys", headers: session });
    expect(JSON.stringify(list.json())).not.toContain(secret);

    const works = await get(`/v1/ask?scope=${PROJ}&subject=engine`, secret);
    expect(works.statusCode).toBe(200);

    const revoke = await app.inject({
      method: "POST",
      url: `/admin/api/keys/${created.json().key.id}/revoke`,
      headers: session,
    });
    expect(revoke.statusCode).toBe(204);

    const dead = await get(`/v1/ask?scope=${PROJ}&subject=engine`, secret);
    expect(dead.statusCode).toBe(401);
  });

  it("shows the refused writes, the contradiction queue and the scope tree", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      payload: { password: "correct-horse-battery-staple" },
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    const session = { cookie: `datum_session=${login.cookies[0]!.value}` };

    const rejections = await app.inject({
      method: "GET",
      url: "/admin/api/rejections",
      headers: session,
    });
    expect(rejections.json().rejections.length).toBeGreaterThan(0);
    expect(rejections.json().by_reason_24h.length).toBeGreaterThan(0);

    const queue = await app.inject({
      method: "GET",
      url: "/admin/api/contradictions?status=open",
      headers: session,
    });
    const first = queue.json().contradictions[0];
    expect(first.a).toBeTruthy();
    expect(first.b).toBeTruthy();

    const resolved = await app.inject({
      method: "POST",
      url: `/admin/api/contradictions/${first.id}/resolve`,
      headers: { ...session, "content-type": "application/json" },
      payload: {
        status: "unreproducible",
        resolution: "kept as an unreproducible historical observation; never publishable",
      },
    });
    expect(resolved.statusCode).toBe(204);

    const scopes = await app.inject({ method: "GET", url: "/admin/api/scopes", headers: session });
    expect(scopes.json().scopes.map((s: { path: string }) => s.path)).toContain(PROJ);

    const detail = await app.inject({
      method: "GET",
      url: `/admin/api/assertions?scope=${PROJ}&live=true`,
      headers: session,
    });
    expect(detail.json().total).toBeGreaterThan(0);
  });
});

afterAll(() => {
  if (sizes.length > 0) {
    const lines = sizes.map((s) => `  ${s.tool.padEnd(28)} ${String(s.bytes).padStart(5)} bytes`);
    console.log(`\n  MCP response sizes (budget ${DEFAULT_BUDGET_BYTES}):\n${lines.join("\n")}\n`);
    for (const s of sizes) {
      if (s.text) console.log(`  --- ${s.tool} ---\n${s.text}\n`);
    }
  }
});
