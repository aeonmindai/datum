# Impact analysis vs grep — the code graph clears its gate

**VERDICT: PASS.** Datum beats the primary grep baseline by **16.0 macro-F1 points**, against a bar
of 10. The prediction in the spec — *"grep loses badly; if it does not, the subsystem is not worth
building"* — held.

Corpus: the real Arc repository at HEAD `526c9099`, 966 files, 19,495 symbols, 128,156 edge rows.
40 questions of the form *"if I change X, what else must I care about?"*, ground truth established
by hand from source and independently revalidated (130 assertions, 0 failures) before any system was
run. Grading is mechanical throughout, per `bench/impact/grade.md`.

## Headline

| arm | macro F1 | precision | recall | **FCR** | **FCQ** | abstain | uncertain |
|---|---|---|---|---|---|---|---|
| **datum** | **0.975** | 0.990 | 0.969 | **0.038** | **0.050** | 0.025 | 0.151 |
| grep-line | 0.815 | 0.819 | 0.975 | 0.542 | 0.250 | 0 | 0 |
| grep-file | 0.221 | 0.216 | 0.975 | 0.988 | 0.825 | 0 | 0 |

Margin over grep-line: **+16.0**. Over grep-file: **+75.4**. Strict F1 (line-matched on every
question) is identical to primary at 0.975, so nothing here is a right file found by luck.

## The number that actually matters

Recall is nearly tied — grep finds the callers, at 0.975 against Datum's 0.969. **Precision is where
they part**, and precision is the axis an engineer feels:

- **FCR, the share of asserted symbols that are wrong: 3.8% vs 54.2%.** More than half of what
  grep-line confidently reports as affected is not affected.
- **FCQ, the share of questions where an engineer would be misled at all: 5.0% vs 25.0%.** One
  question in four.

Micro precision makes the same point more starkly, because it weights by volume rather than by
question: **0.962 vs 0.458**. grep-line asserts 2,110 symbols across the 40 questions to find the
same 85 answers.

## Where the gap opens

| difficulty | datum | grep-line | grep-file |
|---|---|---|---|
| easy (17) | 0.95 | 0.91 | 0.10 |
| ambiguous (5) | **1.00** | **0.36** | 0.05 |
| trait (5) | 0.95 | 0.86 | 0.05 |
| test-only (3) | 1.00 | 1.00 | 0.19 |
| zero-callers (10) | **1.00** | **0.80** | 0.60 |

Two classes decide it.

**Ambiguous names: 1.00 vs 0.36.** Four questions target `from_env`, which has four distinct
definitions in Arc and therefore four different correct answers. A text search cannot tell them
apart and answers all four questions identically; a resolved graph answers each correctly.

**Zero callers: 1.00 vs 0.80.** Ten questions whose correct answer is the empty set. Datum returns
an empty closure and scores a perfect 1.00 on all ten. grep-line reports phantom callers on two of
them and cannot, structurally, express "nothing reaches this" — there is no text search that
distinguishes a symbol's own definition and its doc comments from a call site. That asymmetry is not
an artefact of the question set; it is the finding.

## Sensitivity: does the empty-answer class carry the result?

Ten of the forty questions have an empty correct answer and score 1.0 for an empty closure. That is
a real differentiator — no text search can say "nothing reaches this" — but it has a dangerous
property: **any silent coverage hole produces an empty closure too, and here an empty closure is a
scoreable success.** An unparsed language, an excluded directory, a file skipped for size or a
mangled symbol name all look identical to a correct answer, and no amount of grading the *answers*
would reveal it.

So the class was tested three ways before the headline was accepted:

| scenario | datum | grep-line | margin |
|---|---|---|---|
| all 40 questions | 0.975 | 0.815 | **+0.160** |
| excluding the 10 empty-answer questions | 0.966 | 0.820 | **+0.146** |
| only the 10 empty-answer questions | 1.000 | 0.800 | +0.200 |
| adversarial: assume all 10 are coverage holes, score them 0 | 0.718 | 0.815 | **−0.096** |

The class does not carry the headline — drop it entirely and the gate still clears at +14.6. But if
those ten answers were *wrong*, the verdict inverts to a loss. A metric whose downside is total
inversion is where a cheap audit stops being optional.

**So the ten were audited individually.** For each: the target's file was indexed, the symbol was
found, its name is clean, and — the check that matters — **no edge names it even unresolved**
(`dst_name` count 0 for all ten), so the ambiguity ceiling is not concealing a caller behind a
demoted edge. 0 of 10 suspect. Symbols by language: rust 15,842 / cuda 2,618 / python 682 / c 35, so
every declared language produced symbols and there is no unparsed-language hole in this artifact,
and 0 symbols carry whitespace in their names.

The empty-answer scores are therefore audited, not assumed. A permanent
`stats.symbols_by_language` counter is being added anyway, because the next person to index a repo
containing a language nobody considered would get an empty closure scored as a correct answer with
nothing anywhere to contradict them, and a silent hole that grades as success is the worst failure
shape a benchmark can have.

## What this run does NOT establish

Stated because the numbers above are strong enough to be worth distrusting.

**Not one edge in this index is `measured`.** The confidence histogram over 102,775 edges is
**47,590 derived / 55,185 unverified / 0 measured**. Tree-sitter is neither a compiler nor a
language server, so the indexer refuses to emit `compiler` or `language-server` resolutions at all.
Every true positive here rests on unique-name resolution, not observation. `derived` is the correct
label and it bounds the claim: no edge in the Arc graph can currently satisfy a mission gate that
demands `measured`, and letting `derived` read as `measured` would be the single overclaim this
benchmark exists to refuse.

**9,136 edges were demoted to `unresolved` by the ambiguity ceiling**, and an unresolved edge
produces no hop in any array — invisible to the answer set. It costs recall, and because it cannot
appear in the asserted set it also cannot produce a false-confidence event. That asymmetry favours
Datum's FCR and must not be read as free. Concretely: 42 edges name `gather_forward` and 41 of them
are ceiling-demoted, so a call-scored variant of I22 would have silently lost 41 hops.

**15.1% of Datum's reported symbols are in the `uncertain` bucket** and are scored neither as hits
nor as errors. That is the trade the architecture makes — reporting an ambiguous hop *as* ambiguous
costs recall and buys correctness — and the benchmark prices it rather than hiding it. grep has no
such bucket because a text search cannot say "I am not sure", which is the capability under test.

**One question abstained (I40)**, correctly. Its target exists only at commit `4033b8f4b`, which is
not reachable from HEAD, so it is absent from this index. Abstaining is the honest answer and is
excluded from the macro mean rather than scored as zero.

**n = 40, and the ground truth was written by an agent in this same effort.** It was established by
reading source rather than by querying the indexer — using the indexer as its own oracle would make
the whole exercise circular — and independently revalidated, but it is not an external instrument.

**Both grep baselines were handed advantages.** grep-line attributes hits using the *indexer's own*
symbol boundaries rather than a scan-upward heuristic, which is strictly more accurate than what
`rg` alone provides; and hits with no enclosing function are dropped rather than counted as false
positives. The comparison is deliberately not a straw man.

## Four bugs found on the way to this number

Recorded because three of them would have produced a *wrong published result*, and two were mine.

1. **The runner mapped HTTP 403 to "abstain".** The bench key could not reach the index's scope, so
   the first run reported Datum abstaining on all 40 questions — which under `grade.md` produces no
   score at all, and which a reader skimming `abstain_rate: 1` would have misread as a Datum result.
   Only 400 and 404 are abstentions now; anything else is a hard error.
2. **`ingestGraph` defaulted the index scope to `code/<repo>`,** a root no project key can reach,
   making a freshly ingested graph unreadable by exactly the keys that should read it. The CLI now
   defaults it into the org tree, where scope inheritance works.
3. **The trait composition joined on the type's declaration span.** In Rust the implementing method
   lives in an `impl` block nowhere near the struct, so span containment found 1 of 9 known
   implementors of `QuantMethod::gather_forward`. Matching on qualified name — the relation the
   language actually expresses — fixed it.
4. **`meta.corpus.repo` holds a filesystem path**, not the repo slug the index is keyed by, so every
   route 404'd and the runner counted 40 abstentions.

The underlying capability gap that (3) sits on top of is worth naming separately, because it was a
product defect rather than a benchmark one: `implements` edges run **Type → Trait** and never name a
method, so *"what breaks if I change this trait method"* returned nothing — indistinguishable from
"nothing implements this", which is the most dangerous answer this tool can give. Composition was
added to `impact()` itself rather than to the runner, because an engineer asking the question needs
the answer, not a benchmark harness that knows to ask twice. The composed hop inherits the
`implements` edge's confidence, so it is `derived`, never `measured`, and carries
`via_kind: "implements"` so it is honest about which relation it followed.

## Reproducing

```
datum index --repo <owner/name> --emit graph.json     # needs tree-sitter; runs where the code is
datum ingest-graph graph.json                          # needs nothing
DATABASE_URL=... npx tsx bench/impact/run.mts
```

Raw per-question output: `packages/datum/bench/impact/results.json`.
Question set, ground truth and grading definition: `packages/datum/bench/impact/`.
