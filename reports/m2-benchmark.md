# M2 — the benchmark that decides whether Datum ships

**VERDICT: FAIL.** Datum does not clear the gate in either condition.

Run 2026-08-24T19:49:49Z. One model for all three arms, one
run per question, 33 questions, no repeats.

## The gate

`HANDOFF.md` §16: beat **both** full-context and plain-file-plus-`grep` by **>= 10 points**, score
100% on a stale-fact set where the right answer requires honouring a supersession, and surface zero
dead numbers in a default read.

| criterion | result |
|---|---|
| >= 10 points over both baselines | **FAIL** in both conditions |
| 100% on the stale-fact subset | **FAIL** — 11/14 (78.6%) |
| zero dead numbers in a default read | **PASS** — 0 across 66 question-instances |

## Scores

**Condition 1 — curated context.** The full-context arm was hand-fed the files the answers live in
(`STATE.json`, `RETRACTED.md`, `DOCTRINE.md`, `FACTS.md`). This is a deliberately *generous* baseline.

| arm | correct | % | abstain | wrong | poisoned | context/query |
|---|---|---|---|---|---|---|
| full-context | 33/33 | 100.0% | 0 | 0 | 0 | ~150k tok |
| file + grep | 31/33 | 93.9% | 2 | 0 | 0 | ~3k tok |
| **datum** | 30/33 | **90.9%** | 3 | 0 | 0 | ~5k tok |

Margins: **-9.1** vs full-context, **-3.0** vs grep. **FAIL.**

**Condition 2 — the corpus as it actually was.** 3,153 files, 1,160,241 lines, 63.7 MB (~15.9M
tokens), including all **34 divergent copies** of `FACTS.md` that `HANDOFF.md` names. No curation:
files packed newest-first, a neutral heuristic that does not encode knowledge of where answers live.
Under that rule `RETRACTED.md` **falls out of context entirely** — which is precisely how Arc failed.

| arm | correct | % | abstain | wrong | poisoned | context/query |
|---|---|---|---|---|---|---|
| full-context | 28/33 | 84.8% | 4 | 1 | 0 | ~150k tok (0.9% of corpus) |
| file + grep | 28/33 | 84.8% | 2 | 3 | 0 | ~3k tok |
| **datum** | 30/33 | **90.9%** | 3 | 0 | 0 | ~5k tok |

Margins: **+6.1** vs both. Better than both, and still short of the bar. **FAIL.**

## Why it failed, precisely

Datum's retrieval is not the problem. **On every fact it contains it was correct, and it produced
zero wrong answers across all 66 question-instances** — the only arm that never stated a falsehood.
Both baselines did: full-context 1, grep 3.

It failed on **coverage**. Three of its four misses are facts nobody ever asserted:

- `S07` Is b=1 latency-bound or instruction-bound? — abstained, never in the store
- `S09` What does clone_in_cache actually cost per step? — abstained, never in the store
- `S10` What page_size does SGLang use for V4? — abstained, never in the store

That matters more than it looks. Datum never extracts facts from prose by design — a human or a
verified instrument asserts, or nothing is recorded. So coverage is bounded by human effort in
perpetuity. "Seed more facts" is available, and it is also the answer that should worry you: it
makes the value proposition depend on an unbounded manual input cost. A 66-fact store cannot answer
questions about a 63.7 MB corpus, and no amount of retrieval quality changes that.

## What the numbers do say in Datum's favour

- **It never lied.** 0 wrong, 0 poisoned, both conditions. The baselines' errors were the dangerous
  kind: grep answered `18.27 tok/s` for measured single-user throughput (a stale session-7 number),
  `250 tok/s` for the single-user target (superseded), and `1.84x` for the MTP acceptance multiplier
  (the retracted family). Those are exactly the failures that cost Arc three sessions.
- **It is 30x cheaper per query** — ~5k tokens against ~150k — and the 150k arm still only saw 0.9%
  of the corpus.
- **Removing curation costs the baselines 15 points and costs Datum nothing** (100.0% -> 84.8% for
  full-context, 93.9% -> 84.8% for grep, 90.9% -> 90.9% for Datum). Datum is the only arm whose
  score is invariant to how messy the corpus is, because it does not read the corpus.

## Limits of this experiment — read before acting on it

- **n = 33.** Three questions move the result by 9 points. The margins here are inside the noise of
  a set this small, and there are no repeats, so there is no variance estimate.
- **One model, one run per question.** No temperature sweep, no self-consistency.
- **I wrote the questions and I built the system under test.** That is the wrong person for the job.
- **The answer key and the Datum seed share provenance.** Both were derived from `STATE.json` and
  `RETRACTED.md`, which biases *towards* Datum on covered questions.
- **The stale-fact subset is 14 questions.** The doc asks for 100% on it; Datum scored 11/14, and all
  three misses are coverage, not supersession errors. Zero retracted values were returned.

## Recommendation

By the letter of §16, **stop and decide**. Do not build M3 or M4 on this result.

The honest options, in the order I would consider them:

1. **Re-run with a real evaluation set.** n=33 written by the author is not a decision-grade
   instrument. A pre-registered set of 150+ questions, written by someone who did not build this,
   with repeats, would tell you something this cannot.
2. **Test the claim the architecture actually makes.** This benchmark measured recall. Datum's claim
   is *never stating a false fact*. On that axis it won 4-0 and the gate did not measure it. If that
   is the real product, the gate is the wrong gate — but changing the gate after seeing the result
   is exactly the move §16 warns against, so it needs to be argued on its own merits, in advance,
   and preferably by someone else.
3. **Accept the coverage ceiling as the finding.** If a curated store cannot be kept current without
   ongoing human effort, that cost is the product's true price. Measure it: how long does it take to
   assert the ~200 facts that would have answered all 33 questions, and who does that work?

Raw data: `questions.json`, `results-condition1.json`, `results-condition2.json`.

## Per-question detail

### Condition 1
| id | class | question | full | grep | datum |
|---|---|---|---|---|---|
| C01 | current | What is the measured aggregate tok/s at B=256 on one H200? | correct | correct | correct |
| C02 | current | What is the measured single-user tok/s? | correct | abstain | correct |
| C03 | current | What is the measured cost per Mtok in USD? | correct | correct | correct |
| C04 | current | What is the fitted step-time curve? | correct | correct | correct |
| C05 | current | Which kernel is the primary bottleneck? | correct | correct | correct |
| C06 | current | What share of batch GPU time does the primary bottleneck k | correct | correct | correct |
| C07 | current | What is the hard bake budget in minutes on a single card? | correct | correct | correct |
| C08 | current | What is the bake budget in seconds per layer? | correct | abstain | correct |
| C09 | current | What is the single-user tok/s target? | correct | correct | correct |
| C10 | current | What GSM8K percent is the standing commitment under our pr | correct | correct | correct |
| C11 | current | What is the Runcrate balance in USD? | correct | correct | correct |
| C12 | current | Which single PR is allowed to target master? | correct | correct | correct |
| C13 | current | What does cudnn cost on H200 decode? | correct | correct | correct |
| C14 | current | What does the ragged pair cost as shipped? | correct | correct | correct |
| C15 | current | What does SAMPLE_ON_DEVICE cost? | correct | correct | correct |
| P01 | provenance | Has 640 tok/s single-user been reached? | correct | correct | correct |
| P02 | provenance | Has 14,000 tok/s aggregate at B=256 been reached? | correct | correct | correct |
| P03 | provenance | Is there a reproducible GSM8K measurement on record with a | correct | correct | correct |
| P04 | provenance | Was the <=60-minute single-card bake ever reached? | correct | correct | correct |
| S01 | stale | What is the measured MTP acceptance probability p? | correct | correct | correct |
| S02 | stale | How much is fixing MTP acceptance actually worth, as a mul | correct | correct | correct |
| S03 | stale | How many casts/launches per token does MHC's remaining b=1 | correct | correct | correct |
| S04 | stale | What is the aggregate tok/s target at B=256 on one H200? | correct | correct | correct |
| S05 | stale | How many bits per parameter do we operate on? | correct | correct | correct |
| S06 | stale | How many bytes is the published qtip2b artifact, and how m | correct | correct | correct |
| S07 | stale | Is b=1 latency-bound or instruction-bound? | correct | correct | abstain |
| S08 | stale | Is TCFRAG a pure win that costs only instructions? | correct | correct | correct |
| S09 | stale | What does clone_in_cache actually cost per step? | correct | correct | abstain |
| S10 | stale | What page_size does SGLang use for V4? | correct | correct | abstain |
| S11 | stale | Does the re-bake get cheaper at K8/V4/L12? | correct | correct | correct |
| S12 | stale | Does K4/V4/L12 at 1.38 inst/wt sit at budget and recover t | correct | correct | correct |
| S13 | stale | Is the fused 512 attention kernel neutral? | correct | correct | correct |
| S14 | stale | Is the decode tail 27.2% with fp8_gemv_warp at 16.0%? | correct | correct | correct |

### Condition 2
| id | class | question | full | grep | datum |
|---|---|---|---|---|---|
| C01 | current | What is the measured aggregate tok/s at B=256 on one H200? | correct | correct | correct |
| C02 | current | What is the measured single-user tok/s? | correct | wrong | correct |
| C03 | current | What is the measured cost per Mtok in USD? | correct | correct | correct |
| C04 | current | What is the fitted step-time curve? | correct | correct | correct |
| C05 | current | Which kernel is the primary bottleneck? | correct | correct | correct |
| C06 | current | What share of batch GPU time does the primary bottleneck k | correct | correct | correct |
| C07 | current | What is the hard bake budget in minutes on a single card? | correct | abstain | correct |
| C08 | current | What is the bake budget in seconds per layer? | correct | abstain | correct |
| C09 | current | What is the single-user tok/s target? | correct | wrong | correct |
| C10 | current | What GSM8K percent is the standing commitment under our pr | correct | correct | correct |
| C11 | current | What is the Runcrate balance in USD? | correct | correct | correct |
| C12 | current | Which single PR is allowed to target master? | correct | correct | correct |
| C13 | current | What does cudnn cost on H200 decode? | correct | correct | correct |
| C14 | current | What does the ragged pair cost as shipped? | correct | correct | correct |
| C15 | current | What does SAMPLE_ON_DEVICE cost? | correct | correct | correct |
| P01 | provenance | Has 640 tok/s single-user been reached? | correct | correct | correct |
| P02 | provenance | Has 14,000 tok/s aggregate at B=256 been reached? | correct | correct | correct |
| P03 | provenance | Is there a reproducible GSM8K measurement on record with a | correct | correct | correct |
| P04 | provenance | Was the <=60-minute single-card bake ever reached? | correct | correct | correct |
| S01 | stale | What is the measured MTP acceptance probability p? | abstain | correct | correct |
| S02 | stale | How much is fixing MTP acceptance actually worth, as a mul | wrong | wrong | correct |
| S03 | stale | How many casts/launches per token does MHC's remaining b=1 | abstain | correct | correct |
| S04 | stale | What is the aggregate tok/s target at B=256 on one H200? | correct | correct | correct |
| S05 | stale | How many bits per parameter do we operate on? | correct | correct | correct |
| S06 | stale | How many bytes is the published qtip2b artifact, and how m | correct | correct | correct |
| S07 | stale | Is b=1 latency-bound or instruction-bound? | correct | correct | abstain |
| S08 | stale | Is TCFRAG a pure win that costs only instructions? | correct | correct | correct |
| S09 | stale | What does clone_in_cache actually cost per step? | abstain | correct | abstain |
| S10 | stale | What page_size does SGLang use for V4? | abstain | correct | abstain |
| S11 | stale | Does the re-bake get cheaper at K8/V4/L12? | correct | correct | correct |
| S12 | stale | Does K4/V4/L12 at 1.38 inst/wt sit at budget and recover t | correct | correct | correct |
| S13 | stale | Is the fused 512 attention kernel neutral? | correct | correct | correct |
| S14 | stale | Is the decode tail 27.2% with fp8_gemv_warp at 16.0%? | correct | correct | correct |
