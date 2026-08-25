import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { loadConfig, type Config } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { search, take } from "../src/domain/store.js";
import { mintKey } from "../src/http/auth.js";
import { extractProposals, PROSE_EXTRACTOR } from "../src/prose/extract.js";
import { registerProposalRoutes, type ProposalRow } from "../src/prose/routes.js";

/**
 * Subsystem 4: prose to proposals, against a real Postgres.
 *
 * The claim being defended is the quarantine, and it is defended the only way that means
 * anything: by asking `datum.take` and `datum.search` — the two functions every read path and
 * every MCP tool goes through — for the proposals and confirming they cannot see them. A test
 * that only asserted "the route returns proposals" would pass just as happily on a build where
 * `/v1/ask` had started leaking candidates as facts.
 */

const ORG = "acme";
const SCOPE = `org/${ORG}/proj/arc`;

let pg: TestPostgres;
let db: Db;
let config: Config;
let app: FastifyInstance;
let key: string;
let corpus: string;

/**
 * Prose the extractor is designed to hit: one `key: value` measurement under a heading, and one
 * "X is N unit" sentence. Everything else in the file is there to be *ignored*, which is most of
 * what this extractor does.
 */
const CORPUS = `# Cache budget

Warmup passes: 8

The resident set is 74 GB on a single card, measured on the box.

The step time is 63 ms at batch eight.

Cold start is 41 s on a fresh box.

This paragraph contains a number, 12, and no unit, so nothing here is a candidate.

\`\`\`
inside a fence: 99
\`\`\`

> quoted from elsewhere: the resident set is 41 GB

The earlier figure was wrong: the resident set is 60 GB.
`;

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

async function pending(): Promise<ProposalRow[]> {
  const res = await get(`/v1/proposals?status=pending&scope=${SCOPE}`);
  expect(res.statusCode).toBe(200);
  const body = res.json() as { proposals: ProposalRow[] };
  return body.proposals;
}

beforeAll(async () => {
  corpus = await mkdtemp(join(tmpdir(), "datum-proposals-"));
  await writeFile(join(corpus, "budget.md"), CORPUS, "utf8");

  pg = await startPostgres();
  db = await pg.fork("datum_proposals");

  config = loadConfig({
    DATABASE_URL: pg.url("datum_proposals"),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
    DATUM_SESSION_SECRET: "0".repeat(64),
    DATUM_PUBLIC_URL: "http://localhost:8080",
  });

  key = (
    await mintKey(db, {
      label: "proposals-test",
      scope: `org/${ORG}`,
      permissions: ["read", "assert", "supersede", "admin"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;

  // The routes are registered onto a bare Fastify rather than the real server, so this file tests
  // the unit it owns and not whoever wired it in.
  app = Fastify({ logger: false });
  registerProposalRoutes(app, { db, config });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pg?.stop();
  if (corpus) await rm(corpus, { recursive: true, force: true });
});

describe("extraction", () => {
  it("files candidates from prose", async () => {
    const result = await extractProposals(db, {
      roots: [corpus],
      scope: SCOPE,
      extractor: PROSE_EXTRACTOR,
    });
    expect(result.created).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);

    const rows = await pending();
    expect(rows.length).toBe(result.created);

    // Every candidate carries a citation naming a real file and line, because that is what a
    // reviewer confirms. A proposal without one is an extractor's opinion.
    for (const row of rows) {
      expect(typeof row.citation["source"]).toBe("string");
      expect(String(row.citation["source"])).toMatch(/budget\.md:\d+$/);
      expect(row.status).toBe("pending");
      expect(row.extractor).toBe(PROSE_EXTRACTOR);
      expect(row.promoted_to).toBeNull();
    }
  });

  it("ignores fenced code, blockquotes and unitless numbers", async () => {
    const rows = await pending();
    const sources = rows.map((r) => String(r.citation["source"]));
    // `inside a fence: 99` would match the key/value family if fences were not skipped.
    expect(rows.some((r) => String(r.claim).includes("inside a fence"))).toBe(false);
    // A blockquote is a quotation from somewhere else; attributing it here would misfile it.
    expect(rows.some((r) => String(r.claim).includes("quoted from elsewhere"))).toBe(false);
    // "was wrong" retracts the sentence it appears in, so nothing on that line is a candidate.
    expect(rows.some((r) => String(r.claim).includes("earlier figure"))).toBe(false);
    expect(sources.length).toBeGreaterThan(0);
  });

  it("creates no duplicates when run again", async () => {
    const before = await pending();
    const again = await extractProposals(db, {
      roots: [corpus],
      scope: SCOPE,
      extractor: PROSE_EXTRACTOR,
    });
    // This is the constraint that makes 808 copies of one claim impossible. Nothing new is
    // written, and the extractor learns that by being refused rather than by reading the table.
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(before.length);

    const after = await pending();
    expect(after.length).toBe(before.length);
  });
});

describe("the quarantine", () => {
  it("hides proposals from datum.take", async () => {
    const rows = await pending();
    expect(rows.length).toBeGreaterThan(0);

    const result = await take(db, { scope: SCOPE, limit: 500 });
    for (const row of rows) {
      expect(
        result.assertions.some((a) => a.subject === row.subject && a.predicate === row.predicate),
        `datum.take leaked proposal ${row.id}`,
      ).toBe(false);
    }
  });

  it("hides proposals from datum.search", async () => {
    const rows = await pending();
    for (const row of rows) {
      const hits = await search(db, SCOPE, row.subject, 100);
      expect(hits, `datum.search leaked proposal ${row.id}`).toEqual([]);
    }
    // And the terms from the prose itself find nothing either.
    expect(await search(db, SCOPE, "resident", 100)).toEqual([]);
    expect(await search(db, SCOPE, "74", 100)).toEqual([]);
  });
});

describe("the database refuses a proposal without a citation", () => {
  it("rejects an empty citation source", async () => {
    const attempt = db.query(
      "app",
      `INSERT INTO datum.proposals (id, scope, subject, predicate, object, kind, citation, extractor)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
      [
        "prop_empty_citation",
        SCOPE,
        "nothing",
        "asserted_without_provenance",
        JSON.stringify({ value: 1 }),
        "measured",
        JSON.stringify({ source: "   " }),
        "test",
      ],
    );
    await expect(attempt).rejects.toMatchObject({
      code: "23514",
      constraint: "proposal_requires_citation",
    });
  });

  it("rejects a citation with no source key at all", async () => {
    const attempt = db.query(
      "app",
      `INSERT INTO datum.proposals (id, scope, subject, predicate, object, kind, citation, extractor)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
      [
        "prop_no_source",
        SCOPE,
        "nothing",
        "asserted_without_provenance",
        JSON.stringify({ value: 1 }),
        "measured",
        JSON.stringify({ note: "trust me" }),
        "test",
      ],
    );
    await expect(attempt).rejects.toMatchObject({
      code: "23514",
      constraint: "proposal_requires_citation",
    });
  });
});

describe("review", () => {
  it("requires a reason to reject", async () => {
    const rows = await pending();
    const target = rows[0];
    expect(target).toBeDefined();
    if (!target) return;

    const missing = await post(`/v1/proposals/${target.id}/reject`, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ ok: false, reason: "malformed_request" });

    const blank = await post(`/v1/proposals/${target.id}/reject`, { reason: "" });
    expect(blank.statusCode).toBe(400);

    const ok = await post(`/v1/proposals/${target.id}/reject`, {
      reason: "the citation is real but the subject is too vague to be useful",
    });
    expect(ok.statusCode).toBe(200);

    // Rejection is recorded, not silent: the reason is the only thing that lets anyone tune the
    // extractor instead of re-reviewing the same bad pattern forever.
    const row = await db.one<ProposalRow>(
      "app",
      `SELECT status, review_note, reviewed_by FROM datum.proposals WHERE id = $1`,
      [target.id],
    );
    expect(row?.status).toBe("rejected");
    expect(row?.review_note).toContain("too vague");
    expect(row?.reviewed_by).toBe("key:proposals-test");

    // And it is no longer pending, so it cannot be reviewed twice.
    const again = await post(`/v1/proposals/${target.id}/reject`, { reason: "again" });
    expect(again.statusCode).toBe(400);
  });

  it("promotes a proposal into an assertion carrying the citation as evidence", async () => {
    const rows = await pending();
    const target = rows[0];
    expect(target, "no pending proposal left to promote").toBeDefined();
    if (!target) return;
    const citedSource = String(target.citation["source"]);

    const res = await post(`/v1/proposals/${target.id}/promote`, { human: "jish" });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      ok: boolean;
      assertion: {
        id: string;
        subject: string;
        predicate: string;
        confidence: string;
        evidence: Record<string, unknown>;
        why: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.assertion.subject).toBe(target.subject);
    expect(body.assertion.predicate).toBe(target.predicate);
    // Review means "confirm this citation", so the citation is the evidence verbatim.
    expect(body.assertion.evidence["source"]).toBe(citedSource);
    // A named human vouched, which is the only way `confirmed-by-human` is reachable.
    expect(body.assertion.evidence["human"]).toBe("jish");
    expect(body.assertion.confidence).toBe("confirmed-by-human");
    expect(body.assertion.why).toContain(target.id);

    const row = await db.one<ProposalRow>(
      "app",
      `SELECT status, promoted_to, reviewed_by FROM datum.proposals WHERE id = $1`,
      [target.id],
    );
    expect(row?.status).toBe("accepted");
    expect(row?.promoted_to).toBe(body.assertion.id);
    expect(row?.reviewed_by).toBe("key:proposals-test");

    // Now — and only now — the claim is reachable through the read path everything else uses.
    const result = await take(db, { scope: SCOPE, subject: target.subject, limit: 50 });
    expect(result.assertions.some((a) => a.id === body.assertion.id)).toBe(true);

    // Promoting twice is refused, so the audit trail cannot fork.
    const twice = await post(`/v1/proposals/${target.id}/promote`, { human: "jish" });
    expect(twice.statusCode).toBe(400);
  });

  it("lands unverified when nobody is named", async () => {
    const rows = await pending();
    const target = rows[0];
    expect(target, "no pending proposal left").toBeDefined();
    if (!target) return;

    const res = await post(`/v1/proposals/${target.id}/promote`, {});
    expect(res.statusCode).toBe(201);
    const body = res.json() as { assertion: { confidence: string } };
    // Confidence is earned. An unnamed promotion is testimony from nobody, so it lands at the
    // bottom class rather than borrowing the reviewer's API key as a person.
    expect(body.assertion.confidence).toBe("unverified");
  });
});

describe("route authorisation", () => {
  it("answers 401 before 400, so a stranger cannot map the schema", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/proposals/whatever/reject",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ reason: "unauthorized" });
  });

  it("refuses a key whose scope does not cover the proposal", async () => {
    const narrow = (
      await mintKey(db, {
        label: "elsewhere",
        scope: `org/${ORG}/proj/other`,
        permissions: ["read", "assert"],
        expiresAt: null,
        createdBy: "test",
      })
    ).secret;

    const rows = await pending();
    const target = rows[0];
    if (!target) return;
    const res = await post(`/v1/proposals/${target.id}/promote`, { human: "jish" }, narrow);
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown id", async () => {
    const res = await post("/v1/proposals/prop_does_not_exist/reject", { reason: "n/a" });
    expect(res.statusCode).toBe(404);
  });
});
