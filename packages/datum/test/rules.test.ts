import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { loadConfig, type Config } from "../src/config.js";
import { mintKey } from "../src/http/auth.js";
import { assertFact } from "../src/domain/store.js";
import type { AssertInput } from "../src/domain/types.js";
import {
  deriveRules,
  persistUnenforced,
  registerRulesRoutes,
  scanDoctrine,
  type DeriveRulesResult,
  type UnenforcedFinding,
} from "../src/rules/index.js";

/**
 * Enforcement-derived rules.
 *
 * The whole subsystem stands or falls on one question — is this rule binding? — so the tests are
 * built around the cases where the answer is a judgement in every other tool and a mechanical
 * consequence here: the same ESLint rule at `error` and at `warn`, a clippy `deny`, and a document
 * that bans something with nothing behind it.
 *
 * Fixtures are real files on disk, because the parsers are the thing under test and a fixture handed
 * in as a pre-parsed object would test nothing at all. Postgres is real for the same reason.
 */

const ORG = "rules-test";
const ROOT = `org/${ORG}`;
const SCOPE = `${ROOT}/proj/fixture`;

let fixture: string;
let derived: DeriveRulesResult;
let warnDerived: DeriveRulesResult;
let pg: TestPostgres;
let db: Db;
let config: Config;
let app: FastifyInstance;
let key: string;

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * A repository whose enforcement is deliberately mixed: some rules have teeth, some do not, and one
 * document issues a ban that nothing anywhere implements.
 *
 * `eslintSeverity` is a parameter so the identical rule can be derived twice, at `error` and at
 * `warn`, with nothing else in the tree changed.
 */
function buildFixture(eslintSeverity: "error" | "warn"): string {
  const root = mkdtempSync(join(tmpdir(), "datum-rules-"));

  write(
    root,
    ".github/workflows/ci.yml",
    `name: CI
on:
  pull_request:
    branches:
      - '**'
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx eslint .
      - name: Clippy
        run: cargo clippy --all-targets -- -D warnings
  advisory:
    name: Advisory
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: cargo test
  gate:
    name: Gate
    runs-on: ubuntu-latest
    needs:
      - lint
    if: always()
    steps:
      - name: Assert lane count
        run: |
          set -euo pipefail
          n=1
          if [ "\${n}" -ne "2" ]; then
            echo "::error::lane set drifted"
            exit 1
          fi
`,
  );

  write(
    root,
    ".eslintrc.json",
    `{
  "root": true,
  "rules": {
    "no-restricted-imports": "${eslintSeverity}",
    "prefer-const": "warn",
    "no-console": "off",
    "@typescript-eslint/no-explicit-any": ["${eslintSeverity}", { "fixToUnknown": true }]
  }
}
`,
  );

  write(
    root,
    "Cargo.toml",
    `[package]
name = "fixture"
rust-version = "1.88"

[lints.clippy]
unwrap_used = "deny"
missing_docs_in_private_items = "warn"
too_many_arguments = "allow"

[profile.release]
overflow-checks = true
opt-level = 3
`,
  );

  write(
    root,
    "clippy.toml",
    `disallowed-methods = [
    "std::env::set_var",
    "std::process::exit",
]
too-many-arguments-threshold = 6
`,
  );

  write(root, "rustfmt.toml", "max_width = 100\nerror_on_line_overflow = true\n");

  write(root, "rust-toolchain.toml", '[toolchain]\nchannel = "1.90.0"\n');

  write(root, "CODEOWNERS", "# owners\n/src/crypto/  @security-team\n*.sql          @dba\n");

  write(
    root,
    "docs/POLICY.md",
    `# Engineering policy

## Dependencies

Never use \`left-pad\`. It was removed from npm once and it will happen again.

## Formatting

All code must be formatted with \`rustfmt\` before review.
`,
  );

  return root;
}

beforeAll(async () => {
  fixture = buildFixture("error");
  derived = await deriveRules({ dir: fixture, repo: "acme/fixture", scope: SCOPE });
  const warnFixture = buildFixture("warn");
  warnDerived = await deriveRules({ dir: warnFixture, repo: "acme/fixture", scope: SCOPE });
  rmSync(warnFixture, { recursive: true, force: true });

  pg = await startPostgres();
  db = await pg.fork("datum_rules");
  config = loadConfig({
    DATABASE_URL: pg.url("datum_rules"),
    DATUM_ORG: ORG,
    DATUM_ADMIN_PASSWORD: "correct-horse-battery-staple",
    DATUM_SESSION_SECRET: "0".repeat(64),
    DATUM_PUBLIC_URL: "http://localhost:8080",
  });

  app = Fastify({ logger: false });
  registerRulesRoutes(app, { db, config });
  await app.ready();

  key = (
    await mintKey(db, {
      label: "rules",
      scope: ROOT,
      permissions: ["read", "assert"],
      expiresAt: null,
      createdBy: "test",
    })
  ).secret;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pg?.stop();
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function ruleFor(result: DeriveRulesResult, subject: string, predicate: string): AssertInput {
  const found = result.rules.find((r) => r.subject === subject && r.predicate === predicate);
  if (!found) {
    throw new Error(
      `no rule ${subject}/${predicate}; have ${result.rules.map((r) => `${r.subject}/${r.predicate}`).join(", ")}`,
    );
  }
  return found;
}

describe("severity is what makes a rule binding", () => {
  it("binds an eslint rule at error and refuses to bind the same rule at warn", () => {
    const atError = ruleFor(derived, "lint/eslint/no-restricted-imports", "severity");
    const atWarn = ruleFor(warnDerived, "lint/eslint/no-restricted-imports", "severity");

    expect(atError.object.severity).toBe("error");
    expect(atError.binding).toBe(true);

    // The identical rule, the identical file, the identical CI. Only the severity moved, and that is
    // the whole difference between a rule and a suggestion: eslint exits 0 on warnings.
    expect(atWarn.object.severity).toBe("warn");
    expect(atWarn.binding).toBe(false);
    expect(atWarn.why).toMatch(/exits 0 on warnings/);
  });

  it("reads the severity out of the array form too", () => {
    const rule = ruleFor(derived, "lint/eslint/@typescript-eslint/no-explicit-any", "severity");
    expect(rule.object.severity).toBe("error");
    expect(rule.binding).toBe(true);
  });

  it("never emits a rule that is switched off", () => {
    // `"no-console": "off"` is the absence of a rule. Emitting it would make "we have a rule about
    // console logging" true for something deliberately disabled.
    expect(derived.rules.some((r) => r.subject === "lint/eslint/no-console")).toBe(false);
  });

  it("binds a clippy deny and leaves a clippy warn advisory", () => {
    const denied = ruleFor(derived, "lint/clippy/unwrap_used", "severity");
    expect(denied.object.severity).toBe("deny");
    expect(denied.binding).toBe(true);

    // `-D warnings` is in this fixture's CI, so a warn-level clippy lint does fail a job — and the
    // assertion has to name the escalation rather than merely assert the outcome.
    const warned = ruleFor(derived, "lint/clippy/missing_docs_in_private_items", "severity");
    expect(warned.object.severity).toBe("warn");
    expect(warned.binding).toBe(true);
    expect(warned.evidence.enforced_by).toMatch(/^\.github\/workflows\/ci\.yml:\d+$/);
  });

  it("never emits a lint level of allow", () => {
    expect(derived.rules.some((r) => r.subject === "lint/clippy/too_many_arguments")).toBe(false);
  });

  it("expands a clippy ban list per entry, each citing its own line", () => {
    const ban = ruleFor(derived, "lint/clippy/disallowed-methods/std::env::set_var", "disallowed");
    const other = ruleFor(derived, "lint/clippy/disallowed-methods/std::process::exit", "disallowed");
    expect(ban.evidence.source).toBe("clippy.toml:2");
    expect(other.evidence.source).toBe("clippy.toml:3");
    // Warn-by-default lints, made binding only by `-D warnings` in this fixture's CI.
    expect(ban.binding).toBe(true);
  });
});

describe("a rule must be able to name the line that enforces it", () => {
  it("gives every emitted rule a file:line, or an api pointer for what has no file", () => {
    expect(derived.rules.length).toBeGreaterThan(15);
    for (const rule of derived.rules) {
      const source = String(rule.evidence.source);
      expect(source, `${rule.subject}/${rule.predicate}`).toMatch(
        /^(?:[^\s:][^:]*:\d+|api:[^\s#]+#\S+)$/,
      );
    }
  });

  it("cites a line that actually contains the enforcement", () => {
    const gate = derived.rules.find((r) => r.predicate === "fails_when" && r.object.mechanism === "exit-nonzero");
    expect(gate).toBeDefined();
    // The `exit 1` lives inside a block scalar; a YAML parser that discarded line numbers would put
    // this citation at the `run:` key or nowhere at all.
    expect(String(gate!.evidence.source)).toBe(".github/workflows/ci.yml:34");
    expect(String(gate!.object.expression)).toContain("exit 1");

    const threshold = derived.rules.find((r) => r.object.mechanism === "threshold");
    expect(String(threshold!.evidence.source)).toBe(".github/workflows/ci.yml:32");
    expect(threshold!.object.operator).toBe("-ne");
  });

  it("asserts unverified and nothing stronger", () => {
    // An agent may not write `measured`: reading a config proves the config says so, not that the
    // workflow it describes ever runs. The verification worker earns the promotion.
    for (const rule of derived.rules) expect(rule.confidence).toBe("unverified");
  });
});

describe("a job is enforcement unless the workflow says it cannot fail", () => {
  it("binds an ordinary job", () => {
    expect(ruleFor(derived, "ci/ci/lint", "must_pass").binding).toBe(true);
  });

  it("refuses to bind a continue-on-error job", () => {
    const advisory = ruleFor(derived, "ci/ci/advisory", "must_pass");
    expect(advisory.binding).toBe(false);
    expect(advisory.why).toMatch(/continue-on-error/);
  });

  it("records the aggregate lane list a gate job depends on", () => {
    expect(ruleFor(derived, "ci/ci/gate", "requires_jobs").object.needs).toEqual(["lint"]);
  });
});

describe("settings that configure versus settings that fail", () => {
  it("binds a profile setting that causes a runtime failure and not one that tunes the build", () => {
    expect(ruleFor(derived, "cargo/profile/release/overflow-checks", "set_to").binding).toBe(true);
    const tuning = ruleFor(derived, "cargo/profile/release/opt-level", "set_to");
    expect(tuning.binding).toBe(false);
    expect(tuning.why).toMatch(/nothing can violate it/);
  });

  it("binds the msrv and the pinned toolchain", () => {
    expect(ruleFor(derived, "cargo/msrv", "minimum_rust_version").object.version).toBe("1.88");
    expect(ruleFor(derived, "cargo/msrv", "minimum_rust_version").binding).toBe(true);
    expect(ruleFor(derived, "toolchain/rust/channel", "pinned_to").binding).toBe(true);
  });

  it("binds a rustfmt setting that makes rustfmt itself fail", () => {
    expect(ruleFor(derived, "format/rustfmt/error_on_line_overflow", "configured").binding).toBe(true);
    // Nothing in this fixture's CI runs `cargo fmt --check`, so the width is a specification only.
    const width = ruleFor(derived, "format/rustfmt/max_width", "configured");
    expect(width.binding).toBe(false);
    expect(width.why).toMatch(/cargo fmt --check/);
  });
});

describe("CODEOWNERS without branch protection", () => {
  it("records ownership as advisory and says why, rather than guessing", () => {
    const owned = ruleFor(derived, "ownership//src/crypto/", "owned_by");
    expect(owned.object.owners).toEqual(["@security-team"]);
    expect(owned.binding).toBe(false);
    expect(owned.why).toMatch(/branch protection was not read/);
    expect(owned.evidence.branch_protection_unread).toMatch(/no github token/);
  });

  it("records the skipped network read as a source instead of pretending it looked", () => {
    expect(derived.sources.some((s) => s.startsWith("skipped:branch-protection"))).toBe(true);
  });
});

describe("doctrine with no teeth", () => {
  it("reports a documented ban that nothing implements, and never asserts it", () => {
    const finding = derived.unenforced.find((f) => f.target === "left-pad");
    expect(finding, JSON.stringify(derived.unenforced, null, 2)).toBeDefined();
    expect(finding!.source).toBe("docs/POLICY.md:5");
    expect(finding!.strength).toBe("absolute");
    expect(finding!.marker.toLowerCase()).toBe("never");
    expect(finding!.heading).toBe("Dependencies");

    // The load-bearing half: a report, not a record. Prose may only ever reach the record through
    // the proposal queue, which is what stops an extractor's reading from becoming a fact.
    for (const rule of derived.rules) {
      expect(JSON.stringify(rule)).not.toContain("left-pad");
    }
  });

  it("does not report doctrine that something does enforce", () => {
    // "All code must be formatted with rustfmt" — `rustfmt` is named by a binding rule derived from
    // rustfmt.toml, so the sentence has teeth and must not appear in the report.
    expect(derived.unenforced.some((f) => f.target === "rustfmt")).toBe(false);
  });

  it("checks the object of the imperative, not merely some word in the sentence", () => {
    // The failure this guards: a sentence reading ``Build `--features cuda`; never `cudnn` `` shares
    // the token `cuda` with the CI build command, so a scan that cleared a sentence when *any* token
    // matched would declare the cudnn ban enforced by the command that builds without it.
    const scan = scanDoctrine(
      { dir: fixture, roots: ["docs"], files: [] },
      [
        {
          subject: "ci/build/tool/cargo",
          predicate: "enforces",
          object: {},
          claim: "cargo build --features cuda",
          kind: "rule",
          binding: true,
          locator: ".github/workflows/ci.yml:1",
          enforcerText: "cargo build --features cuda",
        },
      ],
    );
    write(fixture, "docs/GPU.md", "# GPU\n\nBuild `--features cuda`; **never `cudnn`**.\n");
    const after = scanDoctrine(
      { dir: fixture, roots: ["docs"], files: [] },
      [
        {
          subject: "ci/build/tool/cargo",
          predicate: "enforces",
          object: {},
          claim: "cargo build --features cuda",
          kind: "rule",
          binding: true,
          locator: ".github/workflows/ci.yml:1",
          enforcerText: "cargo build --features cuda",
        },
      ],
    );
    expect(scan.findings.some((f) => f.target === "cudnn")).toBe(false);
    const cudnn = after.findings.find((f) => f.target === "cudnn");
    expect(cudnn, JSON.stringify(after.findings.map((f) => f.target))).toBeDefined();
    expect(cudnn!.source).toBe("docs/GPU.md:3");
  });

  it("ignores a never that reports history rather than issuing a rule", () => {
    const root = mkdtempSync(join(tmpdir(), "datum-doctrine-"));
    write(root, "docs/LOG.md", "# Log\n\nThe cuda graph path has never been deployed on hardware.\n");
    const scan = scanDoctrine({ dir: root, roots: ["docs"], files: [] }, []);
    expect(scan.findings).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("unwraps a hard-wrapped ban so the sentence is visible at all", () => {
    const root = mkdtempSync(join(tmpdir(), "datum-doctrine-"));
    // The real shape this exists for: doctrine wrapped at 80 columns, where the ban straddles a line
    // break. A line-based scan structurally cannot see `**W=256 or no bake.**`.
    write(
      root,
      "docs/DOCTRINE.md",
      `# Doctrine

## D4b. NO DEGRADED ARTIFACTS

Fable had staged a fallback, marking the artifact DEGRADED and shipping it anyway. Jish
killed it. **W=256 or no
bake.** Applies to every step.
`,
    );
    const scan = scanDoctrine({ dir: root, roots: ["docs"], files: [] }, []);
    const found = scan.findings.find((f) => f.statement.includes("W=256 or no bake"));
    expect(found, JSON.stringify(scan.findings.map((f) => f.statement))).toBeDefined();
    // Line 6, not line 5: the ban begins mid-paragraph on the second physical line, so the
    // citation is only right if the offset-to-line map survived the unwrap.
    expect(found!.line).toBe(6);
    expect(found!.target).toBe("w=256");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the read surface", () => {
  it("serves binding and advisory rules with counts, from the store", async () => {
    for (const rule of derived.rules) {
      await assertFact(db, { ...rule, asserted_by: "test" }, { role: "app" });
    }

    const res = await app.inject({
      method: "GET",
      url: `/v1/rules?scope=${SCOPE}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      counts: { binding: number; advisory: number; total: number };
      rules: Array<{ subject: string; binding: boolean; evidence: { source: string } }>;
    };
    expect(body.counts.binding).toBeGreaterThan(10);
    expect(body.counts.advisory).toBeGreaterThan(0);
    expect(body.counts.total).toBe(body.counts.binding + body.counts.advisory);
    // Binding first: teeth before advice.
    expect(body.rules[0]!.binding).toBe(true);
    for (const rule of body.rules) expect(rule.evidence.source).toBeTruthy();
  });

  it("filters to advisory rules on request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/rules?scope=${SCOPE}&binding=false`,
      headers: { authorization: `Bearer ${key}` },
    });
    const body = res.json() as { rules: Array<{ binding: boolean }> };
    expect(body.rules.length).toBeGreaterThan(0);
    for (const rule of body.rules) expect(rule.binding).toBe(false);
  });

  it("refuses an unauthenticated read before it looks at the query", async () => {
    // Order is a security property: parsing first lets a stranger map the schema by reading 400s.
    const anon = await app.inject({ method: "GET", url: "/v1/rules?scope=not%20a%20scope" });
    expect(anon.statusCode).toBe(401);
  });

  it("refuses a scope the key does not carry", async () => {
    const narrow = (
      await mintKey(db, {
        label: "narrow",
        scope: `${ROOT}/proj/elsewhere`,
        permissions: ["read"],
        expiresAt: null,
        createdBy: "test",
      })
    ).secret;
    const res = await app.inject({
      method: "GET",
      url: `/v1/rules?scope=${SCOPE}`,
      headers: { authorization: `Bearer ${narrow}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("serves unenforced doctrine as proposals, ranked, and never as assertions", async () => {
    const written = await persistUnenforced(db, { scope: SCOPE, repo: "acme/fixture" }, derived.unenforced);
    expect(written.created).toBe(derived.unenforced.length);

    // Re-running the scan must not manufacture a second copy. This is the constraint that makes 808
    // duplicates of one claim impossible, so it is tested rather than assumed.
    const again = await persistUnenforced(db, { scope: SCOPE, repo: "acme/fixture" }, derived.unenforced);
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(derived.unenforced.length);

    const res = await app.inject({
      method: "GET",
      url: `/v1/rules/unenforced?scope=${SCOPE}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      count: number;
      unenforced: Array<{ claim: string; citation: { source: string; strength: string } }>;
    };
    expect(body.count).toBe(derived.unenforced.length);
    const leftPad = body.unenforced.find((u) => u.claim.includes("left-pad"));
    expect(leftPad).toBeDefined();
    expect(leftPad!.citation.source).toBe("docs/POLICY.md:5");
    expect(leftPad!.citation.strength).toBe("absolute");

    // Nothing in the proposal queue is reachable as a fact.
    const asFacts = await db.query<{ n: string }>(
      "app",
      `SELECT count(*)::text AS n FROM datum.assertions WHERE claim LIKE '%left-pad%'`,
    );
    expect(asFacts.rows[0]!.n).toBe("0");
  });

  it("filters unenforced findings by strength", async () => {
    // Idempotent, so this test does not depend on another having run first.
    await persistUnenforced(db, { scope: SCOPE, repo: "acme/fixture" }, derived.unenforced);
    const res = await app.inject({
      method: "GET",
      url: `/v1/rules/unenforced?scope=${SCOPE}&strength=absolute`,
      headers: { authorization: `Bearer ${key}` },
    });
    const body = res.json() as { unenforced: Array<{ citation: { strength: string } }> };
    expect(body.unenforced.length).toBeGreaterThan(0);
    for (const row of body.unenforced) expect(row.citation.strength).toBe("absolute");
  });
});

describe("a finding carries everything a reviewer needs", () => {
  it("names the citation, the target and why it is considered unenforced", () => {
    const finding: UnenforcedFinding | undefined = derived.unenforced.find((f) => f.target === "left-pad");
    expect(finding!.file).toBe("docs/POLICY.md");
    expect(finding!.line).toBe(5);
    expect(finding!.tokens).toContain("left-pad");
    expect(finding!.why).toContain("left-pad");
    expect(finding!.doctrinal).toBeGreaterThan(0);
  });
});
