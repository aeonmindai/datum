import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { resolveChain } from "../domain/scope.js";
import { resolveIndex } from "../graph/store.js";
import type { EpisodeRow } from "./types.js";

/**
 * "Why is this code like this?"
 *
 * `git blame` answers who and when. It cannot answer why, because the reason was almost never
 * written into the commit message — it was said once, in a conversation, and a transcript is the
 * only place it survives. Measured on the Arc corpus: the sentence that reframed an entire phase
 * ("we reached the 60-minute bake once, then model confusion happened") exists in no file and no
 * commit.
 *
 * So this joins three planes that already existed and were never connected. The code graph knows
 * where a symbol lives, `datum.episodes` knows what was said around it, and `datum.assertions`
 * knows what was recorded as true about it. The answer is a citation list, never a conclusion.
 *
 * Two rules this module does not bend:
 *
 *   1. It is a read path. Nothing here writes an assertion. Promotion from "somebody said this" to
 *      "this is true" stays an explicit act by a person or an instrument, because a module that
 *      quietly minted a fact from every plausible-sounding excerpt is exactly the
 *      extract-then-re-extract loop that manufactured 808 copies of one invented preference
 *      elsewhere.
 *   2. When the answer is weak it says so, in `note`. An empty `mentions` with no note reads as
 *      "there is no reason for this code"; what it actually means is "nobody wrote the reason down
 *      in a transcript this store holds". Those are different, and only one of them is true.
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/** Enough for the sentence around the match. A caller wants the claim, not the whole message. */
const EXCERPT_MAX = 240;
/** Characters of run-up, so an excerpt opens before its subject rather than on top of it. */
const EXCERPT_LEAD = 72;
/** How many candidate locations an ambiguity note enumerates before it stops. */
const AMBIGUITY_LISTED = 6;
/** One more than the ambiguity is worth counting, so `over 200` is measured, not assumed. */
const CANDIDATE_CAP = 201;

export type WhyMatch = "path" | "symbol" | "basename";

export interface WhyMention {
  episode: EpisodeRow;
  /** Which needle hit. `basename` is the weak one: `mod.rs` names a hundred different files. */
  why: WhyMatch;
  excerpt: string;
}

export interface WhyFact {
  id: string;
  claim: string | null;
  confidence: string;
  subject: string;
  predicate: string;
}

export interface WhyResolved {
  kind: "path" | "symbol";
  path?: string;
  fqn?: string;
  line_start?: number;
}

export interface WhyResult {
  target: string;
  /** Null when the target could not be pinned to one place in the code. `note` says why. */
  resolved: WhyResolved | null;
  mentions: WhyMention[];
  facts: WhyFact[];
  note: string | null;
}

function refuse(message: string, detail: Record<string, unknown> = {}, hint?: string): Rejection {
  // `malformed_request` is the only 400 in the shared reason taxonomy, and `domain/reasons.ts` is
  // not this module's to extend.
  return new Rejection({ reason: "malformed_request", message, detail, hint: hint ?? null });
}

function checkedLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw refuse(`limit must be an integer between 1 and ${MAX_LIMIT}`, { limit });
  }
  return limit;
}

/** Repo-relative and slash-normalised, so `./src/a.rs` and `src/a.rs` are one question. */
function normalisePath(raw: string): string {
  const path = raw
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (path.length === 0) throw refuse("path must not be empty", { path: raw });
  return path;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const RE_META = /[.^$*+?()[\]{}|\\-]/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * A needle as a word-bounded, escaped regex.
 *
 * Plain substring matching over prose fails in both directions. Unescaped, `_` and `.` are
 * wildcards, so `gemv_wide.rs` also matches `gemvXwideYrs`. Unbounded, `gemv` matches every
 * mention of `gemv_wide` and a two-character symbol name matches the whole corpus. Word boundaries
 * are what make a mention a mention, and they are why a short identifier can be searched at all
 * rather than refused as too generic.
 *
 * The anchors are conditional: a needle starting with a non-word character has no word boundary to
 * its left, and an anchor there matches nothing — a silent zero-result, the worst kind.
 */
function bounded(needle: string, lead: string, tail: string): string {
  const body = needle.replace(RE_META, "\\$&");
  const before = WORD_CHAR.test(needle.slice(0, 1)) ? lead : "";
  const after = WORD_CHAR.test(needle.slice(-1)) ? tail : "";
  return `${before}${body}${after}`;
}

/** Postgres spells the word boundaries `\m` and `\M`; the trigram GIN index serves `~*`. */
const pgNeedle = (needle: string): string => bounded(needle, "\\m", "\\M");
const jsNeedle = (needle: string): RegExp => new RegExp(bounded(needle, "\\b", "\\b"), "i");

/**
 * The sentence around the first match, whitespace collapsed.
 *
 * Collapsing happens before locating the match so the offsets refer to the string actually
 * returned. Transcript turns are multi-line and a raw window across a pasted code block reads as
 * noise; the point of an excerpt is that a human can judge the citation at a glance.
 */
function excerpt(text: string, needles: RegExp[]): string {
  const flat = text.replace(/\s+/g, " ").trim();

  let at = -1;
  let hit = 0;
  for (const needle of needles) {
    const found = needle.exec(flat);
    if (found && (at < 0 || found.index < at)) {
      at = found.index;
      hit = found[0].length;
    }
  }

  // Reachable when the match straddled something the collapse removed. The head of the message is
  // still a citation the reader can check against the transcript; inventing a window would not be.
  if (at < 0) {
    return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1).trimEnd()}…`;
  }

  let start = Math.max(0, at - EXCERPT_LEAD);
  // A needle longer than the window would otherwise be cropped out of its own excerpt.
  let end = Math.max(Math.min(flat.length, start + EXCERPT_MAX), Math.min(flat.length, at + hit));

  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > at + hit) end = space;
  }

  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

const EPISODE_COLUMNS = `e.id, e.scope, e.session_id, e.seq, e.parent_id, e.occurred_at, e.actor,
  e.role, e.text, e.git_branch, e.git_commit, e.cwd, e.source, e.hash, e.ingested_at`;

interface MentionRow extends EpisodeRow {
  why: WhyMatch;
}

interface Tiers {
  /** The symbol's own name and qualified name. */
  symbol: string[];
  /** The file it lives in, spelled out in full. */
  path: string[];
  /** The bare filename, which is what a human actually types in chat. */
  basename: string[];
}

/**
 * Episodes mentioning any needle, strongest tier first.
 *
 * The tiering is decided in SQL rather than after the fact because it interacts with `limit`: a
 * generic basename can match hundreds of episodes, and sorting client-side would mean the one
 * episode that named the symbol outright never reaches the caller. `~* ANY(...)` over an empty
 * array is false, so an unused tier costs nothing and needs no branch in the statement.
 */
async function findMentions(
  db: Db,
  chain: string[],
  tiers: Tiers,
  limit: number,
): Promise<MentionRow[]> {
  const symbol = tiers.symbol.map(pgNeedle);
  const path = tiers.path.map(pgNeedle);
  const base = tiers.basename.map(pgNeedle);
  if (symbol.length + path.length + base.length === 0) return [];

  const { rows } = await db.query<MentionRow>(
    "app",
    `SELECT m.* FROM (
       SELECT ${EPISODE_COLUMNS},
              CASE WHEN e.text ~* ANY($2::text[]) THEN 'symbol'
                   WHEN e.text ~* ANY($3::text[]) THEN 'path'
                   ELSE 'basename' END AS why
         FROM datum.episodes e
        WHERE e.scope = ANY($1::text[])
          AND (e.text ~* ANY($2::text[])
            OR e.text ~* ANY($3::text[])
            OR e.text ~* ANY($4::text[]))
     ) m
     ORDER BY CASE m.why WHEN 'symbol' THEN 0 WHEN 'path' THEN 1 ELSE 2 END,
              m.occurred_at DESC, m.id DESC
     LIMIT $5`,
    [chain, symbol, path, base, limit],
  );
  return rows;
}

/**
 * Live assertions that name this code.
 *
 * `datum.search` is deliberately not reused here. It searches `claim_fts`, which covers claim,
 * subject and predicate, and this question has to reach `evidence.source` — the field that records
 * a measurement came from this file. A rule about a path is typically written with the path in
 * `subject` and the measuring command in `evidence.source`, and only one of those is indexed.
 *
 * Superseded rows are excluded for the reason the whole store excludes them: an append-only view
 * that still shows retracted claims scores below having no memory at all.
 */
async function findFacts(
  db: Db,
  chain: string[],
  targets: string[],
  limit: number,
): Promise<WhyFact[]> {
  if (targets.length === 0) return [];
  const { rows } = await db.query<WhyFact>(
    "app",
    `SELECT a.id, a.claim, a.confidence, a.subject, a.predicate
       FROM datum.assertions a
      WHERE a.superseded_by IS NULL
        AND a.scope = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM unnest($2::text[]) AS n(needle)
           WHERE a.subject ~* n.needle
              OR coalesce(a.evidence->>'source', '') ~* n.needle
        )
      ORDER BY a.scope_depth DESC, a.asserted_at DESC
      LIMIT $3`,
    [chain, targets.map(pgNeedle), limit],
  );
  return rows;
}

interface IndexRef {
  id: string;
  repo: string;
  commit_sha: string;
}

/**
 * Which code index this question is asked against.
 *
 * With a `repo`, `resolveIndex` decides — the same rule `/v1/graph/impact` uses, so a why-query and
 * an impact-query can never disagree about what "the current index" means. Its refusal for a repo
 * with no completed index is downgraded to an empty list here on purpose: the primary answer on
 * this path is the conversation, and what was said about a file is worth returning whether or not
 * anybody ever ran the indexer over it.
 *
 * Without a `repo` this is `datum.latest_index` generalised to every repo visible in the scope,
 * because that function takes exactly one repo and a scope can hold several. Index scopes are not
 * the scopes conversations live at — the indexer defaults to `code/<owner>/<repo>` — so a
 * descendant of the asking scope counts as well as an ancestor.
 */
async function indexesFor(
  db: Db,
  chain: string[],
  scope: string,
  repo: string | null,
): Promise<IndexRef[]> {
  if (repo) {
    try {
      const index = await resolveIndex(db, { repo });
      return [{ id: index.id, repo: index.repo, commit_sha: index.commit_sha }];
    } catch (err) {
      if (err instanceof Rejection && err.reason === "not_found") return [];
      throw err;
    }
  }
  const { rows } = await db.query<IndexRef>(
    "app",
    `SELECT DISTINCT ON (i.repo) i.id, i.repo, i.commit_sha
       FROM datum.code_index i
      WHERE i.completed_at IS NOT NULL
        AND (i.scope = ANY($1::text[]) OR starts_with(i.scope, $2 || '/'))
      ORDER BY i.repo, i.indexed_at DESC`,
    [chain, scope],
  );
  return rows;
}

interface SymbolCandidate {
  id: string;
  name: string;
  fqn: string | null;
  kind: string;
  path: string;
  line_start: number;
  repo: string;
}

async function findSymbols(
  db: Db,
  indexes: IndexRef[],
  symbol: string,
): Promise<SymbolCandidate[]> {
  if (indexes.length === 0) return [];
  const repoOf = new Map(indexes.map((i) => [i.id, i.repo]));
  const { rows } = await db.query<Omit<SymbolCandidate, "repo"> & { index_id: string }>(
    "app",
    `SELECT s.id::text AS id, s.name, s.fqn, s.kind, s.path, s.line_start, s.index_id
       FROM datum.code_symbols s
      WHERE s.index_id = ANY($1::text[]) AND (s.fqn = $2 OR s.name = $2)
      ORDER BY coalesce(s.fqn = $2, false) DESC, s.path, s.line_start
      LIMIT ${CANDIDATE_CAP}`,
    [indexes.map((i) => i.id), symbol],
  );
  return rows.map(({ index_id, ...rest }) => ({ ...rest, repo: repoOf.get(index_id) ?? "" }));
}

const where = (candidate: SymbolCandidate): string =>
  `${candidate.path}:${candidate.line_start}`;

/** Unique and order-preserving, dropping empties — an empty needle would match every episode. */
function needles(...values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function toMention(row: MentionRow, patterns: RegExp[]): WhyMention {
  const { why, ...episode } = row;
  return { episode, why, excerpt: excerpt(episode.text, patterns) };
}

/**
 * The honest caveat, or null when there is nothing to caveat.
 *
 * Assembled from clauses rather than selected from a table because more than one weakness can hold
 * at once — an unindexed repo whose only mentions arrived by basename is two problems, and a note
 * reporting one of them would be concealing the other.
 */
const noteOf = (parts: string[]): string | null => (parts.length > 0 ? parts.join(" ") : null);

function basenameCaveat(mentions: WhyMention[], base: string): string[] {
  const weak = mentions.filter((m) => m.why === "basename").length;
  if (weak === 0) return [];
  return [
    `${weak} of ${mentions.length} mention${mentions.length === 1 ? "" : "s"} matched only the basename "${base}", which can name a different file in another directory — read the excerpt before trusting it.`,
  ];
}

const silence = (scope: string, target: string): string =>
  `Nothing in the ingested transcripts for scope ${scope} mentions ${target}. The reason was never written down in a transcript this store holds, which is not the same as there being no reason.`;

export async function whyPath(
  db: Db,
  opts: { scope: string; path: string; limit?: number },
): Promise<WhyResult> {
  const path = normalisePath(opts.path);
  const base = basename(path);
  const limit = checkedLimit(opts.limit);
  const { chain } = await resolveChain(db, opts.scope);

  // A path is its own resolution. It is a literal, and unlike a symbol it stays answerable after
  // the file is deleted — which is exactly when someone asks why it was ever written that way.
  const resolved: WhyResolved = { kind: "path", path };

  const rows = await findMentions(
    db,
    chain,
    { symbol: [], path: [path], basename: base === path ? [] : [base] },
    limit,
  );
  const targets = needles(path, base);
  const mentions = rows.map((row) => toMention(row, targets.map(jsNeedle)));
  const facts = await findFacts(db, chain, targets, limit);

  const parts =
    mentions.length === 0
      ? [silence(opts.scope, `"${path}"${base === path ? "" : ` or "${base}"`}`)]
      : basenameCaveat(mentions, base);

  return { target: path, resolved, mentions, facts, note: noteOf(parts) };
}

export async function whySymbol(
  db: Db,
  opts: { scope: string; symbol: string; repo?: string; limit?: number },
): Promise<WhyResult> {
  const symbol = opts.symbol.trim();
  if (symbol.length === 0) throw refuse("symbol must not be empty", { symbol: opts.symbol });
  const limit = checkedLimit(opts.limit);
  const { chain } = await resolveChain(db, opts.scope);

  const indexes = await indexesFor(db, chain, opts.scope, opts.repo ?? null);
  const candidates = await findSymbols(db, indexes, symbol);

  // Exact-first, in tiers, the order `resolveTarget` already established: a qualified-name hit
  // wins outright, and a bare name counts only when nothing matched on `fqn`.
  const exact = candidates.filter((c) => c.fqn === symbol);
  const tier = exact.length > 0 ? exact : candidates;
  const one = tier.length === 1 ? tier[0]! : null;

  const parts: string[] = [];
  let resolved: WhyResolved | null = null;

  if (one) {
    resolved = { kind: "symbol", path: one.path, line_start: one.line_start };
    if (one.fqn !== null) resolved.fqn = one.fqn;
  } else if (tier.length > 1) {
    // Ambiguity is reported, never settled by preference. Attributing a conversation to the wrong
    // file is a confident wrong answer, which is worse than an incomplete one — the same reason
    // the impact query refuses instead of picking a candidate.
    const listed = tier.slice(0, AMBIGUITY_LISTED).map(where).join(", ");
    const more = tier.length > AMBIGUITY_LISTED ? ", …" : "";
    const counted = tier.length >= CANDIDATE_CAP ? "over 200" : String(tier.length);
    parts.push(
      `"${symbol}" names ${counted} symbols in scope ${opts.scope} (${listed}${more}), so it is left unresolved rather than attributed to one of them. Pass repo=, a fully qualified name, or ask about the file with whyPath.`,
    );
  } else if (indexes.length === 0) {
    parts.push(
      opts.repo
        ? `No completed code index for repo "${opts.repo}", so "${symbol}" could not be located in the code; any mentions below matched the name as text only.`
        : `No completed code index is visible from scope ${opts.scope}, so "${symbol}" could not be located in the code; any mentions below matched the name as text only.`,
    );
  } else {
    const where_ = indexes.map((i) => `${i.repo}@${i.commit_sha.slice(0, 7)}`).join(", ");
    parts.push(
      `No symbol named "${symbol}" in the newest index for ${where_}; any mentions below matched the name as text only.`,
    );
  }

  const symbolNames = needles(symbol, one?.name, one?.fqn);
  const base = one ? basename(one.path) : null;
  const rows = await findMentions(
    db,
    chain,
    {
      symbol: symbolNames,
      path: one ? [one.path] : [],
      basename: base !== null && base !== one?.path ? [base] : [],
    },
    limit,
  );
  const targets = needles(...symbolNames, one?.path, base);
  const mentions = rows.map((row) => toMention(row, targets.map(jsNeedle)));
  const facts = await findFacts(db, chain, targets, limit);

  if (mentions.length === 0) {
    parts.push(silence(opts.scope, `"${symbol}"`));
  } else if (base !== null) {
    parts.push(...basenameCaveat(mentions, base));
  }

  return { target: symbol, resolved, mentions, facts, note: noteOf(parts) };
}
