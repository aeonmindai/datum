import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./helpers/postgres.js";
import type { Db } from "../src/db/pool.js";
import { recordEpisode } from "../src/episodes/types.js";
import { expandTerm, expandTerms, type Variant } from "../src/episodes/terms.js";

/**
 * Folding a query term onto the words a person wrote.
 *
 * The two held-out losses this closes are measured, not hypothesised (`bench/episodes/RESULTS.md`
 * §6): H08's rarest term is `login` and the corpus says `logged in`; H03 asks about `batch-1` and
 * the utterance says `b1`. Both source utterances were ABSENT from recall at limit 12, 40 and 100,
 * so neither is a ranking problem and no limit recovers either.
 *
 * These tests assert against a real Postgres using the exact predicate `recall.ts` matches with —
 * `episode_fts @@ plainto_tsquery('english', probe) OR text ILIKE '%probe%'`. Asserting that a fold
 * "looks right" in TypeScript would prove nothing: whether `log` finds `logged in` is a fact about
 * that predicate and that tokeniser, and the only way to know it is to ask the server.
 *
 * The fixture strings are real: three are the source utterances the benchmark names, and the rest
 * are real utterances from the same corpus, present so that precision has somewhere to fail.
 */

let pg: TestPostgres;
let db: Db;

const SCOPE = "org/acme/proj/arc";

/** `label` rides in `source` so a match can be reported as a name rather than an id. */
const FIXTURE: ReadonlyArray<{ label: string; text: string }> = [
  // H08. The question's rarest term is `login`; this says `logged in`.
  { label: "h08", text: "brah its not 3.6 hours doing nothing it took 15 mins plus I logged in" },
  // H03. The question says `batch-1`; this says `b1`.
  { label: "h03", text: "but we aren't 16.57 on b1?" },
  // The identifier that must survive intact. Note it also contains the word `batch`.
  { label: "ident", text: "why is qtip2b_grouped_gemm eating the whole batch?" },
  // H10's `per-layer` / `layer` half.
  { label: "h10", text: "forget the 30s thing, do 42-60s per layer" },
  // Unrelated, from the same corpus. Somewhere for a loose fold to go wrong.
  { label: "gemv", text: "GEMV kernel at 15% peak is pure bs. Other projects do it at 50%" },
  { label: "mega", text: "and the megakernel is the last bit that matters" },
  { label: "cpu", text: "brother I said exactly that, tear down and fix on cpu" },
  { label: "later", text: "I said we would actually look at it later" },
];

/**
 * Exactly the predicate `recall.ts` joins terms with. Nothing else counts as a match, because
 * nothing else is what the server will do with these variants.
 */
async function matches(probe: string): Promise<string[]> {
  const { rows } = await db.query<{ label: string }>(
    "app",
    `SELECT source->>'label' AS label FROM datum.episodes
      WHERE scope = $1
        AND (episode_fts @@ plainto_tsquery('english', $2) OR text ILIKE '%' || $2 || '%')
      ORDER BY seq`,
    [SCOPE, probe],
  );
  return rows.map((r) => r.label);
}

const show = (v: Variant): string => `${v.form}[${v.kind}]`;

beforeAll(async () => {
  pg = await startPostgres();
  db = await pg.fork("episodes_terms");
  await db.query("app", `INSERT INTO datum.scopes (path, kind, label) VALUES ($1,'proj','Arc')`, [
    SCOPE,
  ]);
  let seq = 0;
  for (const { label, text } of FIXTURE) {
    await recordEpisode(db, {
      scope: SCOPE,
      session_id: "s1",
      seq: seq++,
      occurred_at: new Date(Date.UTC(2026, 7, 12, 9, seq)).toISOString(),
      actor: "human:jish",
      role: "human",
      text,
      source: { kind: "test", label },
    });
  }
}, 300_000);

afterAll(async () => {
  await pg?.stop();
});

describe("H08 — login / logged in", () => {
  it("reaches the utterance the exact term cannot", async () => {
    const variants = expandTerm("login");
    const observed = await Promise.all(
      variants.map(async (v) => ({ v, labels: await matches(v.form) })),
    );
    console.log(
      `login -> ${observed.map((o) => `${show(o.v)} => [${o.labels.join(",")}]`).join("  ")}`,
    );

    // The measured starting point: idf 7.295 on a term with df 0. Rare and worthless.
    expect(await matches("login")).toEqual([]);

    expect(variants[0]).toEqual({ form: "login", kind: "exact" });
    const win = observed.find((o) => o.labels.includes("h08"));
    expect(win?.v).toEqual({ form: "log", kind: "stem" });
    // And it found nothing else. A fold that also drags in four unrelated rows has not helped.
    expect(win?.labels).toEqual(["h08"]);
  });

  it("folds the inflections onto the same stem, which is what makes it a fold", () => {
    for (const word of ["login", "logged", "logging", "logins"]) {
      const stem = expandTerm(word).find((v) => v.kind === "stem");
      expect(stem, word).toEqual({ form: "log", kind: "stem" });
    }
  });

  it("produces the other three specified stems", () => {
    const stemOf = (w: string): string | undefined =>
      expandTerm(w).find((v) => v.kind === "stem")?.form;
    expect(stemOf("architectures")).toBe("architectur");
    expect(stemOf("calculations")).toBe("calcul");
  });

  it("refuses the over-stems that would destroy more signal than they recover", () => {
    // `-in` ends a pile of ordinary words. If the particle rule fired on these, a rare key would
    // become a three-letter substring of half the language and recall would get worse, not better.
    for (const word of ["train", "chain", "brain", "domain", "certain", "toolchain", "group"]) {
      const stem = expandTerm(word).find((v) => v.kind === "stem")?.form;
      expect(stem, word).not.toBe(word.slice(0, -2));
    }
    // Porter's m>1 guard, doing the same job on the suffix table.
    expect(expandTerm("logic").find((v) => v.kind === "stem")?.form).not.toBe("log");
    expect(expandTerm("layer").find((v) => v.kind === "stem")?.form).not.toBe("lay");
  });
});

describe("H03 — batch-1 / b1", () => {
  it("reaches the utterance through the abbreviation", async () => {
    const variants = expandTerm("batch-1");
    const observed = await Promise.all(
      variants.map(async (v) => ({ v, labels: await matches(v.form) })),
    );
    console.log(
      `batch-1 -> ${observed.map((o) => `${show(o.v)} => [${o.labels.join(",")}]`).join("  ")}`,
    );

    expect(await matches("batch-1")).toEqual([]);

    expect(variants[0]).toEqual({ form: "batch-1", kind: "exact" });
    const win = observed.find((o) => o.labels.includes("h03"));
    expect(win?.v).toEqual({ form: "b1", kind: "abbrev" });
    expect(win?.labels).toEqual(["h03"]);
  });

  it("generates both spellings of the join, in both directions", () => {
    const formsOf = (t: string): string[] =>
      expandTerm(t).filter((v) => v.kind === "abbrev").map((v) => v.form);
    // `batch-1` itself is already the exact variant, so only the two it is not appear here.
    expect(formsOf("batch-1")).toEqual(["batch1", "b1"]);
    expect(formsOf("batch1")).toEqual(["batch-1", "b1"]);
    expect(formsOf("b1")).toEqual(["b-1"]);
    expect(formsOf("v=4")).toEqual(["v4", "v-4"]);
  });

  it("splits the compound, and drops the part that names nothing", () => {
    const splitsOf = (t: string): string[] =>
      expandTerm(t).filter((v) => v.kind === "split").map((v) => v.form);
    expect(splitsOf("batch-1")).toEqual(["batch", "1"]);
    expect(splitsOf("per-layer")).toEqual(["layer"]);
  });

  it("reaches H10's utterance through the split", async () => {
    const variants = expandTerm("per-layer");
    const observed = await Promise.all(
      variants.map(async (v) => ({ v, labels: await matches(v.form) })),
    );
    console.log(
      `per-layer -> ${observed.map((o) => `${show(o.v)} => [${o.labels.join(",")}]`).join("  ")}`,
    );
    expect(await matches("per-layer")).toEqual([]);
    const win = observed.find((o) => o.labels.includes("h10"));
    expect(win?.v).toEqual({ form: "layer", kind: "split" });
    expect(win?.labels).toEqual(["h10"]);
  });
});

describe("the identifier, which must not be folded away", () => {
  it("keeps its exact form first and never becomes `qtip`", async () => {
    const variants = expandTerm("qtip2b_grouped_gemm");
    const observed = await Promise.all(
      variants.map(async (v) => ({ v, labels: await matches(v.form) })),
    );
    console.log(
      `qtip2b_grouped_gemm -> ${observed.map((o) => `${show(o.v)} => [${o.labels.join(",")}]`).join("  ")}`,
    );

    expect(variants[0]).toEqual({ form: "qtip2b_grouped_gemm", kind: "exact" });
    // Measured on the Arc corpus: `qtip2b_grouped_gemm` has df 1 and `qtip` has df 5, one of which
    // is the human asking "what's the difference between qtip and qtip2b" — a different kernel.
    expect(variants.map((v) => v.form)).not.toContain("qtip");
    expect(variants.every((v) => v.kind === "exact" || v.kind === "split")).toBe(true);
    // Every variant, including the exact form, finds that episode and only that episode.
    for (const o of observed) expect(o.labels, show(o.v)).toEqual(["ident"]);
  });

  it("leaves the other keys in this corpus alone too", () => {
    for (const key of ["tok/s", "page_size", "clone_in_cache", "qtip2b", "fp8", "v=4"]) {
      const variants = expandTerm(key);
      expect(variants[0], key).toEqual({ form: key, kind: "exact" });
      expect(variants.some((v) => v.kind === "stem"), key).toBe(false);
    }
  });
});

describe("where this fold is not redundant with what Postgres already does", () => {
  it("Postgres stems regular inflection itself, and still cannot bridge `login` to `logged in`", async () => {
    const row = await db.one<{
      q_architectures: string;
      q_login: string;
      q_log: string;
      fts_login: boolean;
      fts_log: boolean;
      fts_inflection: boolean;
    }>(
      "app",
      `SELECT plainto_tsquery('english','architectures')::text AS q_architectures,
              plainto_tsquery('english','login')::text         AS q_login,
              plainto_tsquery('english','log')::text           AS q_log,
              episode_fts @@ plainto_tsquery('english','login') AS fts_login,
              episode_fts @@ plainto_tsquery('english','log')   AS fts_log,
              to_tsvector('english','write for two GPU architectures, hopper and blackwell')
                @@ plainto_tsquery('english','architecture')    AS fts_inflection
         FROM datum.episodes WHERE source->>'label' = 'h08'`,
    );
    console.log(
      `tsquery: architectures -> ${row?.q_architectures}, login -> ${row?.q_login}, ` +
        `log -> ${row?.q_log}; h08 fts: login=${row?.fts_login} log=${row?.fts_log}; ` +
        `architecture~architectures=${row?.fts_inflection}`,
    );

    // The server's own half of the predicate already runs Snowball, so `architectures` and
    // `architecture` were never the gap — which is why H31 still weighed `architectures` at df 2
    // while H08 weighed `login` at df 1 on the wrong document. Generic suffix stripping is mostly
    // redundant here, and saying so is the point: this fold earns its keep on the cases below.
    expect(row?.q_architectures).toBe("'architectur'");
    expect(row?.fts_inflection).toBe(true);

    // And here is the case Snowball cannot reach. `login` and `logged in` do not share a lexeme:
    // one is a noun written solid, the other a verb and a stopword. No configuration of the
    // english dictionary joins them, so the particle rule is the only thing that can.
    expect(row?.q_login).toBe("'login'");
    expect(row?.q_log).toBe("'log'");
    expect(row?.fts_login).toBe(false);
    expect(row?.fts_log).toBe(true);
  });
});

/**
 * Thirty terms chosen to break it, not to pass. Pathological input is in here because a term list
 * comes from a person's question and a person will type anything.
 */
const ADVERSARIAL: readonly string[] = [
  "",
  "   ",
  "---",
  "...",
  "_",
  "!!!???",
  "a",
  "ab",
  "1234567890",
  "1,234,567,890",
  "757.5",
  "757.50",
  "2.25",
  "16.57",
  "3.6",
  "42-60",
  "login",
  "logged",
  "architectures",
  "calculations",
  "internationalizations",
  "a".repeat(500),
  "batch-1",
  "batch1",
  "b1",
  "v=4",
  "per-layer",
  "qtip2b_grouped_gemm",
  "qtip2b_grouped_gemm_v2_fp8_kernel_launch_config_override",
  "one-two-three-four-five-six-seven-eight-nine-ten-eleven-twelve",
];

describe("fan-out", () => {
  it("never exceeds 8 variants, on 30 terms including pathological input", () => {
    expect(ADVERSARIAL.length).toBe(30);
    const table = expandTerms([...ADVERSARIAL]);
    expect(table.size).toBe(30);
    const lines: string[] = [];
    for (const term of ADVERSARIAL) {
      const variants = table.get(term);
      expect(variants, JSON.stringify(term)).toBeDefined();
      const vs = variants as Variant[];
      expect(vs.length, JSON.stringify(term)).toBeLessThanOrEqual(8);
      // No probe is ever the empty string: `ILIKE '%%'` is the whole corpus.
      for (const v of vs) expect(v.form.length, JSON.stringify(term)).toBeGreaterThan(0);
      // Every non-degenerate term leads with itself, verbatim.
      if (/[a-z0-9]/i.test(term.trim())) {
        expect(vs[0], JSON.stringify(term)).toEqual({ form: term.trim(), kind: "exact" });
      } else {
        expect(vs, JSON.stringify(term)).toEqual([]);
      }
      lines.push(`${vs.length}  ${JSON.stringify(term).slice(0, 44).padEnd(46)} ${vs.map(show).join(" ")}`);
    }
    console.log(`fan-out (variants, term, forms):\n${lines.join("\n")}`);
    // The cap has to actually bite somewhere or it is not being tested.
    const capped = [...table.values()].filter((v) => v.length === 8);
    expect(capped.length).toBeGreaterThan(0);
  });
});

/**
 * The precision control.
 *
 * A fold that finds the right episode by also finding six wrong ones has moved the cost rather than
 * paid it, so this counts every (variant, episode) pair where a fold matched something that is not
 * what the term was about. The number is asserted exactly: a fold getting looser should fail here,
 * not get absorbed.
 */
const PROBES: ReadonlyArray<{ term: string; target: string | null }> = [
  { term: "login", target: "h08" },
  { term: "batch-1", target: "h03" },
  { term: "per-layer", target: "h10" },
  { term: "qtip2b_grouped_gemm", target: "ident" },
  { term: "16.57", target: "h03" },
  { term: "3.6", target: "h08" },
  { term: "architectures", target: null },
  { term: "calculations", target: null },
];

describe("precision", () => {
  it("reports, exactly, how much each fold costs on this fixture", async () => {
    const offTarget: string[] = [];
    let probes = 0;
    for (const { term, target } of PROBES) {
      for (const v of expandTerm(term)) {
        if (v.kind === "exact") continue;
        probes++;
        const wrong = (await matches(v.form)).filter((l) => l !== target);
        for (const label of wrong) offTarget.push(`${term} -> ${show(v)} matched ${label}`);
      }
    }
    console.log(
      `precision: ${probes} folded probes over 8 terms, ${offTarget.length} off-target ` +
        `(variant, episode) pairs:\n  ${offTarget.join("\n  ") || "none"}`,
    );

    // Measured, not aspired to. Both come from splitting `batch-1`: `batch` finds the
    // qtip2b_grouped_gemm utterance because that sentence also says "batch", and the bare digit
    // `1` finds any text containing a 1. The stem, abbrev and numeric folds are clean here.
    expect(offTarget).toEqual([
      "batch-1 -> batch[split] matched ident",
      "batch-1 -> 1[split] matched h08",
      "batch-1 -> 1[split] matched gemv",
    ]);
    expect(offTarget.every((s) => s.includes("[split]"))).toBe(true);
  });
});
