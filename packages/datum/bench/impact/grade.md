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

Ground-truth `line` values are the `fn` / `def` line as read at `commit`. They are recorded for
every entry, so a strict variant may be reported *in addition* to the primary numbers:

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
`questions.json`. The resolver does exact string equality against `code_symbols.fqn` (then `name`),
so a query key hardcoded in this fixture desyncs the moment the indexer changes its `fqn` spelling.
`target_fqn` is documentation. Resolve at run time instead: `GET /v1/graph/symbols?repo=&q=<target>`
substring-matches name and fqn and returns each candidate's exact `fqn`, `kind`, `path` and
`line_start`; select the candidate matching the question's `target_path` and `target_line` (same
`<= 3` line tolerance as section 3) and feed its returned `fqn` into `/v1/impact`. Ten questions
carry `bare_name_is_ambiguous: true` and would otherwise 400 — `I17`-`I20` all target `from_env`,
which has four distinct Arc-owned definitions and four different correct answers. If the runner
deliberately queries by bare name to exercise the refusal path, a 400 listing all four candidates is
an **abstain**, and that is the correct behaviour, not a failure.

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

## 8. Prohibited

The ground truth in `questions.json` was established by hand, with `rg` and by reading the source at
`commit`. It must never be regenerated from, reconciled against, or "corrected" by the output of any
indexer under test. A benchmark whose oracle is the system under test measures nothing.

If a question's ground truth is believed wrong, the fix is to re-read the source at `commit` and
amend `expect_symbols` **and** its `verified_by` in the same change. Every entry's `verified_by`
states the exact `rg` invocation and the exact lines read, so the check is cheap and does not
require trusting the author.
