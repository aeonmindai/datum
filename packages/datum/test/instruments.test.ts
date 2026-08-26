import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { Rejection } from "../src/domain/errors.js";
import { assertFact } from "../src/domain/store.js";
import type { AssertionRow } from "../src/domain/types.js";
import {
  COMMIT_TIME,
  INSTRUMENT_ASSERTED_BY,
  ingestInstrumentFacts,
  readConfigFacts,
  type InstrumentFact,
} from "../src/instruments/index.js";

/**
 * Facts read off artifacts.
 *
 * The subsystem exists because M2 lost on coverage, so the tests are built around the two ways a
 * coverage instrument goes wrong. It can write something untrue — a file read labelled `measured`
 * — and it can write the same true thing forever, which is the mem0 failure: 808 copies of one
 * claim from a loop nobody noticed. Both are checked against a real Postgres, because both are
 * enforced by the database rather than by this code.
 *
 * Fixtures are real files in a real git repository. The parsers are the thing under test and the
 * commit date is load-bearing for idempotency, so a fixture handed in pre-parsed, or a repo with
 * no commits, would test the wrong thing.
 */

const exec = promisify(execFile);

const SCOPE = "org/instruments-test/proj/fixture";
const REPO = "acme/fixture";

let pg: TestPostgres;
let db: Db;
let dir: string;
let sha: string;
let facts: InstrumentFact[];

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * A tree whose pinned values span every case the readers distinguish: a bound const and an
 * unbound one, a const whose value is an expression, a `static_assert` that pins and one that
 * only permits a set, and the parenthesised Python assert SGLang actually writes.
 */
async function buildFixture(): Promise<{ dir: string; sha: string }> {
  const root = mkdtempSync(join(tmpdir(), "datum-instruments-"));

  write(
    root,
    ".cargo/config.toml",
    `[build]
rustflags = ["-C", "target-cpu=native"]

[target.aarch64-apple-darwin]
rustflags = ["-C", "target-feature=+aes"]

[alias]
b = "build"
`,
  );

  write(
    root,
    ".github/workflows/ci.yml",
    `name: CI
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - name: Compile
        timeout-minutes: 20
        run: cargo build
  open-ended:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test
`,
  );

  write(
    root,
    "src/lib.rs",
    `pub const CACHE_GROW_SIZE: usize = 512;
pub const COALESCE_PAYBACK_STEPS: u64 = 256;
/// Not a bound: nothing in the name says it limits anything.
pub const GREETING: &str = "hello";
/// A bound whose value this reader cannot know without becoming a compiler.
pub const DERIVED_LIMIT: usize = CACHE_GROW_SIZE * 4;
// const COMMENTED_OUT_SIZE: usize = 99;
static SWA_WINDOW: usize = 128;
`,
  );

  write(
    root,
    "kernel.cuh",
    `template <int HEAD_SIZE, int VEC_SIZE>
struct Kernel {
  static_assert(HEAD_SIZE == 128, "TurboQuant supports HEAD_SIZE=128 only");
  static_assert(VEC_SIZE % 4 == 0, "vec_size must be a multiple of 4");
  static_assert(sizeof(int) == 4);
  static_assert(HEAD_SIZE == 128 || HEAD_SIZE == 256, "128 or 256");
};
`,
  );

  write(
    root,
    "backend.py",
    `class V4Backend:
    def __init__(self, model_runner):
        self.page_size = model_runner.page_size
        assert (
            self.page_size == 256
        ), "the system hardcodes page_size=256"

    def plan(self):
        assert self.page_size == 256, "the system hardcodes page_size=256"

    def check(self, topk):
        assert topk == 1  # no message: as likely a fixture as a constraint
        assert self.tp_size == 8, "only tp_size 8 is supported"
`,
  );

  const git = (args: string[]) => exec("git", ["-C", root, ...args]);
  await git(["init", "-q"]);
  await git(["config", "user.email", "instruments@test.invalid"]);
  await git(["config", "user.name", "instruments-test"]);
  await git(["add", "-A"]);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  return { dir: root, sha: stdout.trim() };
}

function bySubject(subject: string): InstrumentFact {
  const found = facts.filter((f) => f.subject === subject);
  expect(found, `no fact for ${subject}`).toHaveLength(1);
  return found[0]!;
}

beforeAll(async () => {
  const fixture = await buildFixture();
  dir = fixture.dir;
  sha = fixture.sha;
  facts = await readConfigFacts({ dir, repo: REPO, commitSha: sha });
  pg = await startPostgres();
  db = await pg.fork("datum_instruments");
}, 240_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("reading pinned values off artifacts", () => {
  it("pins valid_from to the commit date, not the clock", async () => {
    const { stdout } = await exec("git", ["-C", dir, "show", "-s", "--format=%cI", sha]);
    const commitTime = stdout.trim();
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect(fact.evidence[COMMIT_TIME]).toBe(commitTime);
      expect(fact.evidence.commit).toBe(sha);
      expect(fact.evidence.source).toMatch(/:\d+$/);
    }
  });

  it("reads a runtime assert as a constraint and a const as state", () => {
    // The distinction the whole kind mapping rests on. Both are true statements about a value;
    // only one of them makes any other value fail something.
    const pinned = bySubject("pin/backend.py/page_size");
    expect(pinned.kind).toBe("constraint");
    expect(pinned.binding).toBe(true);
    expect(pinned.object.value).toBe(256);
    expect(pinned.predicate).toBe("pinned_to");

    const stated = bySubject("pin/src/lib.rs/CACHE_GROW_SIZE");
    expect(stated.kind).toBe("state");
    expect(stated.binding).toBe(false);
    expect(stated.object.value).toBe(512);
    expect(stated.predicate).toBe("set_to");
  });

  it("reads the parenthesised assert SGLang actually writes, and folds the repeat site", () => {
    // Line-at-a-time this construct is three fragments and none of them is a fact. Both sites in
    // the fixture state the identical thing, so it is one fact with two citations — not two rows,
    // and not one row that silently drops a citation.
    const fact = bySubject("pin/backend.py/page_size");
    expect(fact.evidence.source).toBe("backend.py:4");
    expect(fact.object.also_at).toEqual(["backend.py:9"]);
    expect(fact.object.message).toBe("the system hardcodes page_size=256");
  });

  it("reads static_assert forms, and refuses to flatten a permitted set to one value", () => {
    const pinned = bySubject("pin/kernel.cuh/HEAD_SIZE");
    expect(pinned.object.value).toBe(128);
    expect(pinned.predicate).toBe("pinned_to");
    expect(pinned.kind).toBe("constraint");

    const divisible = bySubject("pin/kernel.cuh/VEC_SIZE");
    expect(divisible.predicate).toBe("divisible_by");
    expect(divisible.object.value).toBe(4);

    // `HEAD_SIZE == 128 || HEAD_SIZE == 256` is a real constraint but it is not the fact
    // "HEAD_SIZE is 128", and there is exactly one HEAD_SIZE fact — the disjunction produced none.
    expect(facts.filter((f) => f.object.name === "HEAD_SIZE")).toHaveLength(1);
    // `sizeof(int) == 4` names no identifier this reader can attribute a value to.
    expect(facts.filter((f) => /sizeof/.test(String(f.object.expression ?? "")))).toHaveLength(0);
  });

  it("emits nothing it would have to guess at", () => {
    const names = facts.map((f) => f.object.name);
    // Value is an expression, not a literal.
    expect(names).not.toContain("DERIVED_LIMIT");
    // Name denotes no bound.
    expect(names).not.toContain("GREETING");
    // Commented out.
    expect(names).not.toContain("COMMENTED_OUT_SIZE");
    // Python assert with no message: as likely a test fixture's arithmetic as a system constraint.
    expect(facts.filter((f) => f.object.name === "topk")).toHaveLength(0);
    // A bound name whose value IS a literal survives, so the exclusions above are not vacuous.
    expect(names).toContain("SWA_WINDOW");
    expect(names).toContain("tp_size");
  });

  it("reads CI timeouts as binding constraints and cargo flags as state", () => {
    const job = bySubject("ci/ci/build");
    expect(job.predicate).toBe("timeout_minutes");
    expect(job.object.minutes).toBe(45);
    expect(job.kind).toBe("constraint");
    expect(job.binding).toBe(true);

    expect(bySubject("ci/ci/build/step/2").object.minutes).toBe(20);
    // A job with no timeout has no timeout fact. Absence is not zero.
    expect(facts.filter((f) => f.subject === "ci/ci/open-ended")).toHaveLength(0);

    const flags = bySubject("cargo/config/build/rustflags");
    expect(flags.kind).toBe("state");
    expect(flags.binding).toBe(false);
    expect(flags.object.value).toEqual(["-C", "target-cpu=native"]);
    // `[alias]` is convenience, not what the compiler does.
    expect(facts.filter((f) => f.subject.startsWith("cargo/config/alias"))).toHaveLength(0);
  });
});

describe("ingesting them", () => {
  it("lands every fact as unverified", async () => {
    const result = await ingestInstrumentFacts(db, {
      scope: SCOPE,
      facts,
      assertedBy: INSTRUMENT_ASSERTED_BY,
    });
    expect(result.refused).toEqual([]);
    expect(result.asserted).toBe(facts.length);
    expect(result.duplicates).toBe(0);

    const { rows } = await db.query<{ confidence: string; n: string }>(
      "app",
      `SELECT confidence, count(*)::text AS n
         FROM datum.assertions
        WHERE scope = $1 AND asserted_by = $2
        GROUP BY confidence`,
      [SCOPE, INSTRUMENT_ASSERTED_BY],
    );
    // One group, and it is `unverified`. Confidence is earned by the verification worker; nothing
    // an instrument writes arrives already trusted.
    expect(rows).toEqual([{ confidence: "unverified", n: String(facts.length) }]);

    const { rows: kinds } = await db.query<{ kind: string }>(
      "app",
      `SELECT DISTINCT kind FROM datum.assertions
        WHERE scope = $1 AND asserted_by = $2 ORDER BY kind`,
      [SCOPE, INSTRUMENT_ASSERTED_BY],
    );
    expect(kinds.map((r) => r.kind)).toEqual(["constraint", "state"]);
  });

  it("is idempotent: re-reading the same commit produces duplicates, not rows", async () => {
    const before = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions WHERE scope = $1`,
      [SCOPE],
    );

    // A genuinely fresh read, not a replay of the same objects: the whole risk is that something
    // in the pipeline is time-dependent, and reusing `facts` would hide exactly that.
    const reread = await readConfigFacts({ dir, repo: REPO, commitSha: sha });
    const result = await ingestInstrumentFacts(db, {
      scope: SCOPE,
      facts: reread,
      assertedBy: INSTRUMENT_ASSERTED_BY,
    });

    expect(result.asserted).toBe(0);
    expect(result.duplicates).toBe(reread.length);
    const after = await db.one<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions WHERE scope = $1`,
      [SCOPE],
    );
    expect(after?.n).toBe(before?.n);
  });

  it("refuses a fact it could not re-assert idempotently", async () => {
    const source = facts[0]!;
    const { [COMMIT_TIME]: _dropped, ...evidence } = source.evidence;
    const undated: InstrumentFact = { ...source, subject: "pin/undated/X", evidence };

    const result = await ingestInstrumentFacts(db, {
      scope: SCOPE,
      facts: [undated],
      assertedBy: INSTRUMENT_ASSERTED_BY,
    });
    // Refused rather than stamped with `now()`: a moving `valid_from` moves the content hash, so
    // this row would be appended fresh on every run.
    expect(result.refused).toEqual([{ subject: "pin/undated/X", reason: "no_commit_time" }]);
    expect(result.asserted).toBe(0);
  });

  it("refuses an unciteable fact and a second value for the same subject", async () => {
    const base = bySubject("pin/backend.py/page_size");
    const result = await ingestInstrumentFacts(db, {
      scope: SCOPE,
      facts: [
        { ...base, subject: "pin/nowhere/Y", evidence: { ...base.evidence, source: "nowhere.py" } },
        { ...base, subject: "pin/conflict/Z" },
        { ...base, subject: "pin/conflict/Z", object: { ...base.object, value: 64 } },
      ],
      assertedBy: INSTRUMENT_ASSERTED_BY,
    });

    expect(result.asserted).toBe(1);
    expect(result.refused).toEqual([
      // No line, so the verification worker could never resolve it and the row would sit at
      // `unverified` forever, indistinguishable from a guess.
      { subject: "pin/nowhere/Y", reason: "no_locator" },
      // Two artifacts claiming different values for one subject is a finding, not a coin flip
      // decided by file order.
      { subject: "pin/conflict/Z", reason: "conflicting_value_in_batch" },
    ]);
  });

  it("reports the constraint name when the database refuses a write", async () => {
    const base = bySubject("pin/kernel.cuh/HEAD_SIZE");
    const result = await ingestInstrumentFacts(db, {
      scope: SCOPE,
      // A blank subject clears every check this module makes and then dies inside Postgres. That
      // ordering is the point: the ingester does not attempt to mirror the schema's rules, so the
      // reason a caller sees is the one the database gave rather than this file's guess at it.
      facts: [{ ...base, subject: "   " }],
      assertedBy: INSTRUMENT_ASSERTED_BY,
    });
    expect(result.asserted).toBe(0);
    expect(result.refused).toEqual([{ subject: "   ", reason: "subject_present" }]);
  });
});

describe("what an instrument may not claim", () => {
  it("REFUSES a direct measured write, by name", async () => {
    const fact = bySubject("pin/backend.py/page_size");
    const attempt = assertFact(
      db,
      {
        scope: SCOPE,
        subject: "pin/backend.py/page_size/forged",
        predicate: fact.predicate,
        object: fact.object,
        claim: fact.claim,
        kind: fact.kind,
        // Reading a file is not measuring it. The refusal is the point of the subsystem: an
        // instrument that could label its own output `measured` would launder every guess.
        confidence: "measured",
        evidence: { ...fact.evidence, source: fact.evidence.source },
        valid_from: String(fact.evidence[COMMIT_TIME]),
        asserted_by: INSTRUMENT_ASSERTED_BY,
      },
      { role: "app" },
    );

    await expect(attempt).rejects.toThrow(Rejection);
    const err = await attempt.catch((e: unknown) => e as Rejection);
    expect(err.reason).toBe("confidence_is_earned");
    expect(err.sqlstate).toBe("23514");
    expect(err.detail.permitted_confidence).toEqual(["unverified", "confirmed-by-human"]);

    const forged = await db.one<AssertionRow>(
      "app",
      `SELECT id FROM datum.assertions WHERE subject = $1`,
      ["pin/backend.py/page_size/forged"],
    );
    expect(forged).toBeNull();
  });

  it("leaves the verification worker a resolvable claim", async () => {
    // `measured` is reachable, just not by asserting it: the worker needs a commit to resolve and
    // a path to find the claim at. Every row carries both, which is what makes the refusal above
    // a gate rather than a dead end. Counted as a ratio against every instrument row, so a
    // sibling test adding one more row cannot turn this green or red by accident.
    const row = await db.one<{ total: string; resolvable: string }>(
      "app",
      `SELECT count(*)::text AS total,
              count(*) FILTER (
                WHERE evidence ? 'commit'
                  AND length(btrim(evidence->>'commit')) > 0
                  AND nullif(evidence->>'path', '') IS NOT NULL
              )::text AS resolvable
         FROM datum.assertions
        WHERE scope = $1 AND asserted_by = $2`,
      [SCOPE, INSTRUMENT_ASSERTED_BY],
    );
    expect(Number(row?.total)).toBeGreaterThanOrEqual(facts.length);
    expect(row?.resolvable).toBe(row?.total);
  });
});
