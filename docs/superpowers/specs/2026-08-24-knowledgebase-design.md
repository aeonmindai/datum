# Datum as a knowledgebase — design

Status: approved 2026-08-24. Supersedes nothing; extends v0.

## Why

M2 failed, and it failed for a specific reason worth restating: Datum was correct on every fact it
held and stated **zero falsehoods in 66 question-instances** — the only arm that never lied — but it
only held 66 facts against a 63.7 MB corpus. The ceiling is coverage, and coverage was capped by the
rule that nothing may be extracted from prose.

The fix is not to relax that rule. It is to notice that **most of what an org knows is not prose.**
Code structure, CI config, lint rules, ownership, branch protection and test coverage are all
machine-readable. They are instrument facts, and Datum's own doctrine already permits an instrument
to assert. The coverage problem was self-inflicted by only ever ingesting documents.

## The four subsystems

| # | subsystem | source of truth | hallucination risk |
|---|---|---|---|
| 1 | code graph + impact analysis | parsers, compiler, LSP | none |
| 2 | enforcement-derived rules | CI, lint, CODEOWNERS, branch protection | none |
| 3 | trust-graded read with prose fallback | the corpus, at query time, never stored | none — never persisted |
| 4 | prose to proposals | prose, via a review queue | contained by construction |

Order is 1 → 2 → 3 → 4. Each is independently useful and each makes the next cheaper.

## 1. Code graph and impact analysis

### The finding that shapes the schema

Code edges **cannot** be assertions. `subject=foo, predicate=calls` with two different targets, both
live, overlapping validity, is a direct violation of invariant 3's exclusion constraint — one symbol
calls many others, so the second edge would be refused by the database. Modelling the graph as
assertions would either corrupt invariant 3 or require adding `object` to the exclusion key, which
would weaken the one guarantee the product is built on.

So the graph gets its own tables, and invariant 3 is left exactly as it is. This is also the right
call semantically: a call edge is not a contested claim about the world, it is a derived index of a
specific commit. It does not need per-fact supersession; it needs to be pinned to a commit.

### Tables

`code_index` — one row per (repo, commit, indexer version). The unit of versioning.
`code_symbols` — id, index_id, kind (function|type|module|macro|test|constant), name, qualified
  name, language, path, line span, visibility, signature hash.
`code_edges` — index_id, src symbol, dst symbol, kind (calls|imports|uses_type|implements|tests|
  references), plus **`confidence`** and `resolution`.

### The differentiator: edge confidence

Every code-intelligence product — Sourcegraph, Glean, CodeQL, SCIP/LSIF — gives you edges. None of
them tells you **how much to trust each edge.** Datum labels them with the same taxonomy it uses for
everything else:

- `measured` — resolved by a compiler or language server. This edge is a fact.
- `derived` — resolved by unique-name matching: exactly one symbol in the index bears the name.
- `unverified` — the name is ambiguous. The edge is recorded **with its candidate set**, so an impact
  query can say "this may also reach these three, I could not tell which."

An impact answer that silently mixes certain and guessed edges is the code-intelligence equivalent
of returning a bare number, which is the thing this whole project exists to refuse.

### Bitemporality is the second differentiator

LSIF and SCIP indexes are snapshots — they cannot answer "what called this in August." Because
`code_index` is keyed by commit and never mutated, Datum can: *"this call edge existed at 4d03b9e2
and disappeared when 8ae2090 landed."* That is a question no shipped tool answers, and it is exactly
the question that would have caught "branch work quoted as shipped."

### Impact query

`datum impact <symbol> [--depth N] [--commit SHA]` and `GET /v1/impact`. Returns the reverse
dependency closure: who reaches this symbol, at what depth, over which edges, with each hop's
confidence, plus which tests cover it and which paths sit behind a feature flag. The answer must
degrade honestly: an ambiguous hop is reported as ambiguous, never dropped and never asserted.

### Decoupling from the server

The parser is a build-time concern, not a runtime one. `datum index --emit graph.json` runs wherever
the code is (a dev machine, CI) and needs tree-sitter; `datum ingest-graph graph.json` loads the
artifact and needs nothing. The server image therefore carries no native parser dependency.

## 2. Enforcement-derived rules

Rules that a machine enforces are derivable, and the machine's config *is* the rule. Ingest GitHub
Actions workflows, lint configs, `CODEOWNERS`, branch protection, and test names.

The mechanical definition that makes `binding` derivable rather than a judgement call:

> **A rule is binding if violating it fails something. Otherwise it is advice.**

Fails CI, blocks a merge, trips a lint error → `binding: true`. Appears only in a document →
`binding: false`. These land as ordinary assertions (there are tens of them, not millions, and they
*are* contested claims about how the org works), with `evidence.source` pointing at the config file
and line that enforces them.

The valuable by-product: **unenforced doctrine becomes visible.** A rule written in a document that
nothing enforces is reported as exactly that. On Arc this immediately flags `never cudnn` and the
W=256 ban as doctrine with no teeth — which is precisely how a hard constraint rots quietly.

## 3. Trust-graded read with prose fallback

`/v1/ask` gains a second section. When the exact-first structured lookup misses, the corpus is
searched at query time and results are returned **alongside** the assertions, not merged into them:

```jsonc
{ "assertions": [ /* the record: measured, confirmed-by-human, derived, unverified */ ],
  "from_prose":  [ /* file:line citations, retrieved live, NEVER persisted */ ] }
```

Nothing from prose is ever written to the store, so the store cannot rot and the confidence taxonomy
stays at four classes. A `from_prose` result can never satisfy a mission gate, for the same reason
testimony cannot: gates read a confidence class, and prose has none.

This alone would have answered all three questions Datum abstained on in M2 — the facts were in the
corpus; Datum simply had no permission to look.

## 4. Prose to proposals

A `proposals` table, never readable through `/v1/ask`. An extractor reads prose and writes candidates
carrying a `file:line` citation. Promotion is an ordinary assert whose evidence is that citation, so
review means *"confirm this citation"* rather than *"trust an extractor."* Candidates must never feed
back into extraction — that recall-to-re-extraction loop is what manufactured mem0's 808 copies of
one hallucinated preference.

Built last on purpose: once subsystem 3 already produces cited prose answers, promotion is nearly
free, and the risky version never gets built.

## Acceptance

Nothing here is done until it is measured, and each subsystem carries a falsifiable test:

1. **Impact analysis vs grep.** A set of impact questions whose answer is a reverse-dependency
   closure, graded mechanically, with grep as the baseline. Prediction: grep loses badly. If it does
   not, the subsystem is not worth building.
2. **Rules.** Every derived binding rule must name the config file and line that enforces it, and
   the unenforced-doctrine list must be non-empty on Arc.
3. **Read surface.** M2 re-run. The three abstentions must become correct, and no `from_prose`
   result may ever satisfy a gate.
4. **Proposals.** No proposal is reachable from `/v1/ask` or `/mcp`. Verified by test.

Then M2 is re-run in full, against the same 33 questions plus the new impact set, and reported with
the same discipline as the first run: mechanical grading, both corpus conditions, limits stated.
