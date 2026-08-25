# M2, re-run — and the honest limits, tested

Two results. The gate now passes, but **only with the prose fallback**, and the distinction matters
more than the number.

Same 33 questions as the first run, same mechanical grading, same corpus. What changed: the store is
seeded and verified (11 rows promoted to `measured` against the real Arc repo), and a fourth arm
exists — the store *plus* a live prose fallback that returns citations and never writes them.

**Three repeats per question per arm**, which the first report explicitly lacked and which turned
out to matter.

## Result

| arm | mean | per repeat | wrong | poisoned | flaky questions |
|---|---|---|---|---|---|
| full-context | 84.8% | 84.8 / 84.8 / 84.8 | 6 | 0 | 0 |
| grep | 84.8% | **90.9 / 78.8 / 84.8** | 7 | 0 | **7 of 33** |
| datum, store only | 90.9% | 90.9 ×3 | **0** | 0 | 0 |
| **datum + prose fallback** | **97.0%** | 97.0 ×3 | **0** | 0 | 0 |

| arm | vs full-context | vs grep | gate (≥10 over both) |
|---|---|---|---|
| datum, store only | +6.1 | +6.1 | **FAIL** |
| datum + prose | +12.1 | +12.1 | **PASS** |

## The cost of an answer, which turns out to be a result

The run's wall-clock time made this visible: **90.3% of the entire benchmark's token spend is one
arm.** Full-context re-sends the whole notes pile for every question and every repeat.

| arm | context per answer | total input tokens for the run | share |
|---|---|---|---|
| full-context | **150,555** | 14,904,945 | **90.3%** |
| grep | ~3,000 (×2 calls) | 594,000 | 3.6% |
| datum, store only | **4,922** | 487,278 | 3.0% |
| datum + prose | 5,322 | 526,878 | 3.2% |

**Datum answers for 31× less context than full-context** — and the 150k-token arm still only saw
**0.9%** of the corpus. This was sitting in the benchmark's runtime the whole time and was being
treated as an inconvenience rather than measured as an outcome. It is the same claim the MCP facade
makes at the response end, and it holds at the request end too.

It also decides how this benchmark should be run in future: full-context showed **0.0 spread across
three identical repeats**, so repeats buy nothing there and cost 10M tokens. grep is the only arm
where repeats are load-bearing, because it is the only arm that is not deterministic.

## Read the passing number correctly

The fallback closes the gap by letting Datum search prose it was previously forbidden to read. Of
the three questions the store alone abstained on, prose answered two and **one still abstains**
(`S09`, `clone_in_cache` costing +572 ms — it is in `RETRACTED.md` and the search still did not
surface it).

So: **+6.1 is the architecture's number. +12.1 is the architecture plus permission to read your
notes.** Both are in the table because publishing only the second would be the overclaim this
project exists to refuse. The store-only arm still fails the bar set in `HANDOFF.md` §16.

## What the repeats revealed

This is the part the first report could not have told you, because it ran each question once.

**grep swings 12.1 points across identical repeats** — 78.8% to 90.9% — and is unstable on **7 of
33 questions**. Its "84.8%" is one sample from a wide distribution; run it on a Tuesday and it beats
Datum's store-only arm, run it again and it loses by 12.

All three Datum arms have **0.0 spread**. Retrieval from a structured store is deterministic;
retrieval by having a model choose grep patterns is a coin flip. That is a difference in kind, and
the first report's single-run design hid it entirely.

**Still zero wrong answers and zero retracted numbers, across 99 runs of each Datum arm.** The
baselines produced 13 wrong answers between them. One example worth quoting, because it shows what
"wrong" costs: asked whether the ≤60-minute bake was ever reached, both baselines answered a flat
*"Yes — reached once, then lost."* Datum answered *"Contested. Jish states it was reached once, but
no instrument record survives."* Both scored correct. Only one of them is safe to act on.

---

# The honest limits, tested

Three limitations were declared in the impact-benchmark report. Each is now measured rather than
asserted.

## A. Is `derived` trustworthy? — **not externally auditable. This is a real weakness.**

Every code fact Datum holds about Arc is `derived` (name resolution), never `measured` (compiler).
The declared limit was that `derived` should not be read as `measured`. Testing *whether the label
is accurate* produced an uncomfortable answer:

**It cannot be checked from the artifact.** Resolution uses a suffix index, and **28% of derived
edges (13,336 of 47,564) name a target that matches no exact fully-qualified name and no exact bare
name in the index.** An outside auditor cannot replicate the rule that produced the label, so cannot
confirm it. In a sample of 40, four pointed at bare names shared by 2–4 symbols and were still
labelled unique; whether those were correctly disambiguated by module path or are mislabels is not
determinable from the published artifact.

The only evidence for the label is indirect: on 40 hand-verified impact questions, precision was
**0.990** and false-confidence **3.8%**, and essentially every edge involved was `derived`. So
`derived` edges behave as roughly 99% precise on that set — but a confidence label that cannot be
independently verified is weaker than one that can, and this one currently cannot. **Making
resolution externally auditable is the highest-value fix outstanding.**

## B. Is the `uncertain` bucket over-caution? — **no. It earns its keep.**

Datum reports some hops as "maybe" rather than asserting them, which costs recall. Is that caution
warranted, or is it hiding good answers?

14 hops across 6 of 40 questions, concentrated on the `ambiguous` difficulty class — exactly where
you would want it. Promoting every one of them to a firm answer:

| | micro precision | false-confidence rate | recall gained |
|---|---|---|---|
| as shipped | 0.962 | 3.8% | — |
| all `uncertain` promoted | 0.817 | 18.3% | **0** |

**Every one of the 14 falls outside the ground truth.** Promoting them buys nothing and costs 14.5
points of false confidence. The bucket is not timidity; it is the mechanism doing its job.

## C. What does the ambiguity ceiling cost? — **5.9% of recall, and it is visible.**

9,413 edges are demoted to `unresolved` when a name has more than eight candidates. Such an edge
produces no hop at all, so it costs recall while being unable to produce a false-confidence event —
an asymmetry that flatters the headline unless it is measured.

Measured: **5 of 85 ground-truth symbols missed, across 4 of 40 questions** (5.9%). Recall of 0.969
is therefore real, not an artefact of strategic silence.

## Where that leaves the three claims

| claim | verdict |
|---|---|
| `derived` is not `measured` | true, and the label is **not independently checkable** — weakest point in the system |
| the `uncertain` bucket is worth its recall cost | **confirmed**: 0 recall forgone, 14.5 points of false confidence avoided |
| the ceiling's cost is real but bounded | **confirmed**: 5.9% recall, on 4 of 40 questions |

Raw data: `bench/m2/results-rerun.json`, `packages/datum/bench/impact/results.json`.
