import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchProse, type ProseHit } from "../src/prose/search.js";

/**
 * Subsystem 3: the prose fallback.
 *
 * Nothing here touches a database, and that is the property under test as much as anything else:
 * `searchProse` reads the filesystem and returns citations. If it ever needed a `Db`, the store
 * would have started accumulating prose and the confidence taxonomy would have a fifth class.
 *
 * The three claims worth defending mechanically:
 *   1. an exact phrase outranks an incidental co-occurrence of the same terms,
 *   2. every citation's `path:line` really contains the text it reports, and
 *   3. the byte cap is load-bearing, not decorative.
 */

let dir: string;

/** Filler so the corpus has enough lines for IDF and `avgdl` to mean something. */
const FILLER = Array.from(
  { length: 40 },
  (_, i) => `line ${i} of routine narrative text about scheduling and memory layout`,
).join("\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "datum-prose-"));

  // The exact match is deliberately the LONGER line. BM25's length normalisation would rank the
  // short incidental line first on its own, so if the exact line wins it is the phrase boost
  // doing it rather than an accident of line length — which is what the test is for.
  await writeFile(
    join(dir, "a-exact.md"),
    `# Kernel notes\n${FILLER}\nthe gather kernel issue bound was recorded during the second run\n${FILLER}\n`,
    "utf8",
  );
  await writeFile(
    join(dir, "b-incidental.md"),
    `# Triage\n${FILLER}\ngather bound issue kernel\n${FILLER}\n`,
    "utf8",
  );
  // Underscored identifiers must be findable by someone who typed the words separately.
  await writeFile(
    join(dir, "c-identifiers.md"),
    `# Symbols\n${FILLER}\nself.require_k4v2l16("gather_forward")?\n${FILLER}\n`,
    "utf8",
  );
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Read the cited file back and confirm the line says what the hit claims it says. */
async function citedLine(hit: ProseHit): Promise<string> {
  const text = await readFile(hit.path, "utf8");
  const lines = text.split(/\r?\n/);
  const line = lines[hit.line - 1];
  expect(line, `${hit.path}:${hit.line} does not exist`).toBeDefined();
  return line ?? "";
}

describe("prose search ranking", () => {
  it("ranks an exact phrase above an incidental co-occurrence of the same terms", async () => {
    const hits = await searchProse({
      roots: [dir],
      query: "gather kernel issue bound",
      limit: 10,
    });

    const exact = hits.find((h) => h.path.endsWith("a-exact.md"));
    const incidental = hits.find((h) => h.path.endsWith("b-incidental.md"));
    expect(exact, "the exact-phrase line was not returned at all").toBeDefined();
    expect(incidental, "the incidental line was not returned at all").toBeDefined();
    if (!exact || !incidental) return;

    expect(hits[0]?.path).toBe(exact.path);
    expect(exact.score).toBeGreaterThan(incidental.score);
  });

  it("finds a compound identifier from its separate words, and vice versa", async () => {
    const spaced = await searchProse({ roots: [dir], query: "gather forward", limit: 5 });
    expect(spaced[0]?.path.endsWith("c-identifiers.md")).toBe(true);

    const joined = await searchProse({ roots: [dir], query: "require_k4v2l16", limit: 5 });
    expect(joined[0]?.path.endsWith("c-identifiers.md")).toBe(true);
    expect(joined[0]?.text).toContain("require_k4v2l16");
  });

  it("returns nothing rather than something when no line matches", async () => {
    const hits = await searchProse({ roots: [dir], query: "zzzznonexistenttoken", limit: 5 });
    expect(hits).toEqual([]);
  });

  it("is deterministic: the same query twice returns the same ordering", async () => {
    const first = await searchProse({ roots: [dir], query: "kernel bound", limit: 10 });
    const second = await searchProse({ roots: [dir], query: "kernel bound", limit: 10 });
    expect(second.map((h) => `${h.path}:${h.line}`)).toEqual(
      first.map((h) => `${h.path}:${h.line}`),
    );
  });
});

describe("prose citations", () => {
  it("points every citation at the line that actually contains the text", async () => {
    const hits = await searchProse({ roots: [dir], query: "gather kernel issue bound", limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(await citedLine(hit)).toBe(hit.text);
      expect(hit.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("includes the surrounding lines in the snippet", async () => {
    const hits = await searchProse({ roots: [dir], query: "gather kernel issue bound", limit: 1 });
    const hit = hits[0];
    expect(hit).toBeDefined();
    if (!hit) return;
    const lines = (await readFile(hit.path, "utf8")).split(/\r?\n/);
    expect(hit.snippet).toContain(hit.text);
    // Two lines of context either side, so a reader sees the claim in its paragraph.
    expect(hit.snippet).toContain(lines[hit.line - 2] ?? "");
    expect(hit.snippet).toContain(lines[hit.line] ?? "");
  });
});

describe("the byte cap", () => {
  let capDir: string;

  beforeAll(async () => {
    capDir = await mkdtemp(join(tmpdir(), "datum-prose-cap-"));
    // Sorted first, so it is taken first and eats the budget.
    await writeFile(join(capDir, "a-small.md"), "the needle is here in the small file\n", "utf8");
    await writeFile(
      join(capDir, "b-large.md"),
      `${"padding line that exists only to make this file large\n".repeat(2000)}the needle is here in the large file\n`,
      "utf8",
    );
  });

  afterAll(async () => {
    if (capDir) await rm(capDir, { recursive: true, force: true });
  });

  it("skips a file that does not fit the budget", async () => {
    const capped = await searchProse({
      roots: [capDir],
      query: "needle",
      limit: 10,
      // Enough for the small file, nowhere near enough for the large one.
      maxBytes: 200,
    });
    expect(capped.length).toBe(1);
    expect(capped[0]?.path.endsWith("a-small.md")).toBe(true);
  });

  it("returns the same line once the budget allows it, proving the cap was the reason", async () => {
    const uncapped = await searchProse({
      roots: [capDir],
      query: "needle",
      limit: 10,
      maxBytes: 16 * 1024 * 1024,
    });
    const paths = uncapped.map((h) => h.path);
    expect(paths.some((p) => p.endsWith("a-small.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("b-large.md"))).toBe(true);
  });
});
