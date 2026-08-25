# Impact analysis vs grep — grading definition

This file defines the grading of `questions.json` completely. It is written to be implemented
without asking the author a question. Where a choice could go two ways, the choice is stated and
the reason for it is given, because the reason is what stops the next person from "fixing" it.

Authority for the subsystem being tested: `docs/superpowers/specs/2026-08-24-knowledgebase-design.md`,
acceptance criterion 1 — *"a set of impact questions whose answer is a reverse-dependency closure,
graded mechanically, with grep as the baseline. Prediction: grep loses badly. If it does not, the
subsystem is not worth building."*

Scope, corpus commit and exclusion set live in `meta.json`. A run whose indexer used a different
exclusion set is not comparable and must not be reported alongside one that did.

---

## 1. What a question asks

Each question names a target symbol at a `target_path` : `target_line` in the Arc repo, pinned to
`commit`. It asks: **if I change this, what else must I care about?**

The ground truth `expect_symbols` is the set of *function-like* symbols holding a direct static
reference to the target, at `depth: 1`, inside the scoped file set. For a trait method declaration,
an implementation of that method counts as a referrer (an `implements` edge) as well as any body
that calls it.

**The unit is a caller symbol, deduplicated — never a call site, an edge, or a grep hit.** A function
that references the target from three lines is **one** entry, not three. This matches the API, whose
`code_impact` query is `DISTINCT ON (symbol_id)` so a caller appears once at its nearest depth and
strongest confidence, and it is verified on the real graph: `vec_apply_llama_rope` has 5 inbound edge
rows and 4 distinct callers, returning 4 hops. It is also the semantically right unit, which is why
it was chosen before the API was checked — two call sites inside one function are one thing an
engineer has to go and fix.

`I08` exists to hold this line. `prefill_admission_cap` is called twice, at
`default_scheduler.rs:531` and `:574`, and both calls are inside `DefaultScheduler::schedule`, so
`expect_symbols` has exactly one entry. Ground truth was built this way throughout: no question has
two entries with the same `name`+`path`+`line`, asserted mechanically. A fixture built by counting
call sites, edges or grep hits would over-count against the API and score correct answers as
incomplete, and `grep_hits_code` is recorded separately precisely so the two units are never
confused: `I22` has 146 textual hits against 9 correct answers, `I12` has 19 against 6.

`expect_none: true` means the correct answer is the **empty set**. Ten of the forty questions are
of this kind. An empty answer is a positive claim, not a failure to answer, and it is graded as one.

## 2. The answer universe

Before scoring, a system's answer is reduced to a set of symbols. Only symbols whose `kind` is
**function-like** participate: `function`, `method`, `test`, `kernel`. Everything else — modules,
types, traits, constants, fields — is **discarded silently**, neither credited nor penalised.

Discarded, and therefore never scorable in either direction:

- module-level `use` / `pub use` re-exports (they are imports, not referrers, and they do not change
  when a signature changes);
- doc comments and line comments that name the symbol;
- string literals containing the symbol name;
- hits in files outside `meta.json`'s extension list (`.md`, `.json`, `.html`, `.sh`, `.toml`);
- a second `extern` declaration of the same C symbol (it is a redeclaration, not a caller).

This universe is fixed so that a system is not punished for *having* richer output than the
benchmark grades.

## 3. Matching a reported symbol to a ground-truth symbol

The match key is **`name` + `path`**.

`path` must be repo-relative, forward slashes, no leading `./` — the form `meta.json` fixes and the
form the indexer artifact uses. A grader may normalise a reported path into that form; it may not
normalise anything else.

**Line disambiguation.** Two questions (`I24`, `I25`) have ground-truth entries that share a
`name` + `path` pair, because a trait method is implemented three times inside one file
(`mistralrs-quant/src/distributed/layers.rs`). Those questions carry
`line_disambiguation_required: true`. On such a question, and only on such a question, a reported
symbol additionally matches on line: it is assigned to the ground-truth entry `e` minimising
`|reported_line - e.line|`, and only if that distance is `<= 3`. Each ground-truth entry absorbs at
most one reported symbol; further reports of the same key are false positives.

The `<= 3` tolerance exists because a symbol's declared start line depends on whether the indexer
counts a preceding attribute or doc comment as part of the symbol. Three lines is enough slack for
that and far too little to reach the next same-named sibling, which in both questions is hundreds
of lines away.

Ground-truth `line` values are the **referring symbol's declaration line** — its `fn` / `def` /
kernel-name line as read at `commit` — never the line of the call itself. `I17` is the worked
example: the answer is `QtipBakeConfig::get`, whose declaration is `qtip/mod.rs:975`, and whose call
to the target sits four lines down at `:979`. The fixture records 975. This matches what
`/v1/impact` reports: a hop carries the symbol's `line_start`, not the call site. Confirmed against a
real load of the Arc index, which returns 975 for that hop. A grader comparing against call-site
lines would be comparing the wrong number, and no tolerance would save it.

They are recorded for every entry, so a strict variant may be reported *in addition* to the primary
numbers:

- **primary** — match on `name` + `path`, with line disambiguation only where flagged;
- **strict** — match on `name` + `path` + `|reported_line - e.line| <= 3`, on every question.

Report both. Primary is the headline. Strict is the one that catches a system that found the right
file by luck.

## 4. Per-question precision, recall, F1

Let `E` be the ground-truth set, `A` the system's reduced answer set, and
`TP = |A ∩ E|`, `FP = |A \ E|`, `FN = |E \ A|`.

```
precision = TP / (TP + FP)
recall    = TP / (TP + FN)
F1        = 2 · precision · recall / (precision + recall)
```

**The empty cases, stated explicitly so nobody has to guess.**

| `E` | `A` | precision | recall | F1 |
|---|---|---|---|---|
| empty | empty | 1 | 1 | **1** |
| empty | non-empty | 0 | 1 | **0** |
| non-empty | empty | 1 | 0 | **0** |

The `E` empty / `A` empty row is the important one: on the ten `expect_none` questions, saying
nothing is the *only* right answer and it scores a perfect 1. Defining `0/0 = 1` here is not a
convenience — the whole point of those questions is that a correct system produces an empty
reverse-dependency closure and a text search structurally cannot.

Where `precision + recall = 0`, `F1 = 0`.

**Aggregation.** Report the **macro** mean of per-question precision, recall and F1 — the unweighted
mean over the 40 questions. Also report the **micro** figures, computed from summed `TP`, `FP`, `FN`
across all questions, excluding `expect_none` questions from the micro recall denominator (they
contribute no true positives and would otherwise silently dilute it). Macro is the headline: it
weights the ten empty-answer questions equally with the nine-answer trait ones, which is the correct
weighting because a confident wrong answer on a dead symbol is exactly as expensive as one on a live
symbol.

Also report macro F1 **broken down by `difficulty`**. A system that scores well only on `easy` has
not built the subsystem the spec asked for.

## 5. The metric that matters: false confidence

A wrong impact answer delivered confidently is what makes an engineer break production. Precision
already penalises it, but precision averages it away against everything the system got right. So it
gets its own number.

Each system, per question, must place every symbol it reports into exactly one of three buckets:

| bucket | meaning |
|---|---|
| `certain` | the system asserts this symbol is affected |
| `uncertain` | the system reports this symbol as a maybe, flagged as such |
| `abstain` | the system declines to answer the question at all |

For the Datum arm the mapping is fixed by the `/v1/impact` contract:

```
certain(q)   = reached_by ∪ covered_by_tests.filter(h => h.path_confidence !== "unverified")
               deduplicated on symbol_id
uncertain(q) = ambiguous  ∪ covered_by_tests.filter(h => h.path_confidence === "unverified")
               deduplicated on symbol_id
```

- HTTP 400 refusal whose `detail.candidates` contains the target → **abstain** for that question
- HTTP 404 (unknown symbol / no completed index) → **abstain** for that question

**The fourth thing an edge can be: `unresolved`.** A call whose name matches more than eight symbols
is emitted `unresolved` — `dst` null, `dst_name` preserved — rather than ambiguous, on the ground
that a three-hundred-element candidate list for "one of the things called `new`" carries no decision
value. On Arc HEAD 9,413 edges are demoted this way. An unresolved edge produces **no hop in any of
the three arrays**, so it is invisible to the answer set: it costs recall, it cannot appear in
`certain`, and it therefore cannot produce a false-confidence event. That asymmetry is the correct
behaviour and it must not be reported as if it were free. Every run must therefore also report the
artifact's `stats.resolution_ambiguity_ceiling`, so a reader can see how much of any recall shortfall
is a structural omission rather than a lookup failure. A missing recall point bought by silence is
still a missing recall point, and a report that shows only `FCR` next to a high recall has hidden the
trade rather than measured it.

**Trait questions need two hops, and the runner must take both.** `implements` edges run
**Type → Trait**, not type-method → trait-method: measured on the arc HEAD artifact, *zero*
`implements` edges name a method symbol, and for `gather_forward` specifically 42 edges name it of
which 41 are ceiling-demoted `unresolved`. So the nine implementations that are the correct answer to
`I22` are simply not reachable by querying the method.

The five questions `I22`–`I26` therefore carry `requires_trait_composition: true` together with
`declaring_trait_fqn`, `declaring_trait_path`, `declaring_trait_line` and a `resolution_path` field
spelling out the two hops. On those questions the runner MUST:

1. query impact on `declaring_trait_fqn` to obtain the implementor types over `implements`;
2. for each implementor type, select the symbol whose name equals the question's `target` and whose
   definition lies inside that type;
3. union that with the single-hop result on the method itself (which supplies the call-site answers,
   such as `load_from_artifacts` in `I24` and `extract_calibration_artifact` in `I25`).

A single-hop score on these five is **not** a valid result and must not be reported as one. It would
measure a composition the query surface does not perform and label it a missing edge — the exact
inversion of what this benchmark exists to detect. The edges are present: resolve `QuantMethod` and
all nine implementors come back structurally, with no ceiling involved.

If a runner cannot compose, the honest reporting is to mark `I22`–`I26` **not attempted**, exclude
them from the macro means, and say so. That is a smaller and more useful claim than a recall figure
built on a fixture the API was never asked the right question.

The filter on `covered_by_tests` is load-bearing, not defensive. `covered_by_tests` spans **both**
confidence classes by design, so a test reached only through an ambiguous hop appears in
`covered_by_tests` carrying `path_confidence: "unverified"` *and* in `ambiguous[]`. Unioning the two
arrays unfiltered would pull that hop into the hit set while it is also being scored as the third
class — double counting, and worse, it would promote a guess to a certainty, which is the exact
property this section exists to measure. Every hop in `reached_by` is `measured` or `derived` by
construction, so the one filter makes `certain` precisely "the resolved closure including resolved
test coverage" and leaves `uncertain` a clean disjoint class. The test-only questions `I27`-`I29`
are unaffected: a test reaching its target over a resolved `tests` edge is already in `reached_by`.

**Malformed-answer guard.** Before grading any `/v1/impact` response, assert
`counts.measured + counts.derived === reached_by.length` and
`counts.unverified === ambiguous.length`. If either fails the answer is malformed and must not be
graded — record it as a run error, never as a score.

Those two assertions are jointly sufficient to prove the partition is intact, and they cover the
unions as well. Confirmed against `src/graph/store.ts`: one loop builds all three arrays, every hop
goes into exactly one of `reached_by` or `ambiguous` (`if (path_confidence === "unverified")
ambiguous.push(hop); else reached_by.push(hop);`) and then *additionally* into `covered_by_tests`
when `kind === "test"`. So `covered_by_tests ⊆ (reached_by ∪ ambiguous)` always — it is a view over
the same hops, never a source of hops that appear nowhere else — and the two unions above are
provably no-ops on cardinality. Assert that too: if a dedup ever *changes* a count, that is a bug in
the store, not a real extra hop, and the run must stop rather than score it. The unions are kept in
the definition anyway, because they are what makes the filter's load-bearing role legible to whoever
reads this next.

**Resolving the target symbol.** Do **not** query `/v1/impact` with the `target_fqn` string from
`questions.json`, and do not feed back a returned `fqn` either. An fqn is not unique: loading Arc
found seven distinct symbols sharing the exact fqn `vllm::fma` — CUDA overloads across
`dtype_float16.cuh`, `dtype_bfloat16.cuh` and `dtype_float32.cuh` — so no fqn query can ever reach
one specific overload. `target_fqn` is documentation only.

Resolve by **symbol id**:

1. `GET /v1/graph/symbols?repo=&q=<target>` — substring-matches name and fqn, returning each
   candidate's `id`, `fqn`, `kind`, `path` and `line_start`;
2. select the candidate whose `path` equals the question's `target_path` and whose `line_start` is
   within the section 3 `<= 3` tolerance of `target_line`;
3. query `/v1/impact` with `symbol=id:<that id>`, which resolves absolutely and scoped to the index
   and cannot be ambiguous.

This makes the question set independent of every naming convention, which is the property worth
having. Ten questions carry `bare_name_is_ambiguous: true` and would 400 if queried by bare name —
`I17`-`I20` all target `from_env`, which has four distinct Arc-owned definitions and four different
correct answers, and a real load confirms the refusal lists exactly those four. If the runner
deliberately queries by bare name to exercise the refusal path, that 400 is an **abstain** and is the
correct behaviour, not a failure. The refusal body carries `detail.disambiguate_by: "id" | "fqn"`, so
a runner can tell mechanically whether qualifying would help at all — where it reads `"id"`,
qualifying by name cannot work and only the id path will resolve.

**`measured` is zero on this corpus, and that is the correct answer.** The Arc HEAD index resolves
with a histogram of unique-name 47,564 / ambiguous-name 10,863 / unresolved 44,023, and **zero**
`measured`: tree-sitter is neither a compiler nor a language server, so the indexer refuses that
label rather than inflating it. The
entire `certain` set on Arc is therefore `derived` — sound but inferred, not observed. Nothing in this
file depends on a `measured` hop existing, and `counts.measured === 0` must never be treated as a
fault. It does bound what the run can claim: every true positive reported here rests on unique-name
resolution, and a compiler or language-server pass over the same corpus would be the thing that
turns those into facts. Say that in the report rather than letting `derived` read as `measured`.

Then:

```
false_confidence_events(q) = |{ s ∈ certain(q) : s ∉ E(q) }|

FCR  = Σ_q false_confidence_events(q) / Σ_q |certain(q)|          # rate over asserted symbols
FCQ  = |{ q : false_confidence_events(q) > 0 }| / 40              # fraction of questions poisoned
```

Report both. `FCR` says how much of what the system asserts is wrong. `FCQ` says how often an
engineer asking a question would be misled at all, which is the number that decides whether the
answer is usable.

Report alongside them, because the trade is the whole argument:

```
abstain_rate   = |{ q : system abstained }| / 40
uncertain_rate = Σ_q |uncertain(q)| / Σ_q (|certain(q)| + |uncertain(q)|)
```

**A symbol in `uncertain` is never a false-confidence event, and never a true positive either.** It
does not enter `TP`, `FP` or `FN`; it is removed from `A` before the section 4 arithmetic and counted
only in `uncertain_rate`. This is the asymmetry the product is built on: reporting an ambiguous hop
*as ambiguous* costs recall and buys back correctness, and the benchmark must price that trade
honestly rather than quietly rewarding a guess.

Likewise an abstained question is excluded from the macro means (and its exclusion is visible in
`abstain_rate`), never scored as `F1 = 0`. Refusing to answer and answering wrongly are different
acts and must not produce the same number. A refusal whose candidate set does **not** contain the
true target is not an abstention — it is a wrong answer, scored with `A` = the candidate set.

## 6. The grep baselines

Two, because they bracket what a competent engineer actually does with `rg`. Both run over exactly
the file set `meta.json` defines, so no baseline is penalised for reading files the indexer skipped.

**`grep-line` (primary baseline).** Run `rg -w '<target>'`. For each hit, attribute it to the
function-like symbol whose body encloses that line, resolved by scanning upward to the nearest
enclosing `fn` / `def` / `__global__` declaration at a lower indentation. Drop the target's own
definition line. Report every remaining symbol as `certain`. Hits with no enclosing function (a
module-level `//!` comment, a top-level string literal) are dropped rather than attributed — this
is the *most* favourable reading of grep, and it is used deliberately so that the comparison cannot
be dismissed as a straw man.

**`grep-file` (recall ceiling).** Every function-like symbol defined in any file containing a
textual hit, reported as `certain`. This is what "grep told me which files to look at" costs when
scored, and it exists to show the shape of the trade rather than to be taken seriously.

Neither baseline has an `uncertain` bucket and neither can abstain: a text search cannot express
"I am not sure", which is precisely the capability under test. `expect_none` questions are therefore
the baselines' worst cases, and that is not an accident of the question set — it is the finding.

Every question carries `grep_hits_all`, `grep_hits_code` and `grep_files_code`, measured at `commit`
over the scoped tree. They are descriptive metadata, recorded so the baselines can be sanity-checked
against an independent count rather than trusted. Across the 40 questions there are **367** textual
hits in code files against **85** correct answers.

## 7. Required output

Per question: `id`, `difficulty`, `precision`, `recall`, `F1` (primary and strict),
`|A|`, `TP`, `FP`, `FN`, `false_confidence_events`, bucket sizes, and the raw reported symbol set.
Keeping the raw set is what makes a disputed grade re-checkable without a re-run.

Per system: macro P/R/F1, micro P/R/F1, macro F1 by `difficulty`, `FCR`, `FCQ`, `abstain_rate`,
`uncertain_rate`.

**The bitemporal question.** `I40` is pinned to commit `4033b8f4b`, not to HEAD, and its ground truth
is four symbols. At HEAD the target does not exist at all, and `4033b8f4b` is not an ancestor of
HEAD. A system that holds only one index cannot answer it and must **abstain**; scoring it as a miss
would be scoring it for a question it was never asked. A system that answers it must state which
commit it answered for, and an answer for the wrong commit is a false-confidence event, not a
partial credit. `I23` is the control: the same nine-symbol answer set at both commits, with every
line number moved. Line drift alone is not a bitemporal difference, and a report that conflates the
two has not tested the claim.

## 7a. Stated limit of this metric

This must appear in the report, because it is a property of the grading scheme rather than of any
system being graded.

Ten of the forty questions score a perfect 1.0 for an empty answer, which is correct — an empty
reverse-dependency closure is a positive claim and a text search cannot produce one. But it follows
that **any silent coverage hole in the indexer masquerades as a correct zero-callers answer.** A
symbol the parser mangled, a language the walker does not parse, an excluded directory, a file skipped
for size: all of them return an empty closure, and an empty closure is a scoreable success here.

This is not hypothetical. Six CUDA functions were indexed under names containing whitespace, which no
call site can ever resolve to, so they had zero inbound edges. Had one of them been a target, this
benchmark would have recorded a perfect score for a total coverage hole — a worse failure than a
wrong caller, and invisible to any check that grades answers, because the answers looked right.

Three cheap structural defences exist and any run should state which it has:

1. the indexer's own invariant audits (every symbol's declared span contains its own name; no
   identifier contains whitespace; no name is a bare language specifier; no fqn is unreachable by a
   syntactically valid call) — currently five audits reporting zero;
2. a `symbol_names_with_whitespace` counter carried on the index row;
3. **a per-language symbol count compared against the per-language file count.** A language with
   files and no symbols is a coverage hole that no closure query can reveal, and neither of the first
   two defences would catch an excluded directory or an unparsed language.

Defence 3 does not exist yet. Until it does, the honest form of any high score on the `zero-callers`
class is "correct, subject to the coverage audits listed above", not "correct".

## 8. Prohibited

The ground truth in `questions.json` was established by hand, with `rg` and by reading the source at
`commit`. It must never be regenerated from, reconciled against, or "corrected" by the output of any
indexer under test. A benchmark whose oracle is the system under test measures nothing.

If a question's ground truth is believed wrong, the fix is to re-read the source at `commit` and
amend `expect_symbols` **and** its `verified_by` in the same change. Every entry's `verified_by`
states the exact `rg` invocation and the exact lines read, so the check is cheap and does not
require trusting the author.
