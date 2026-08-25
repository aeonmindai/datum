# Episode retrieval, measured — and it fails the gate

`packages/datum/bench/episodes/SPEC.md` is the full spec, question set and per-arm loss analysis.
This is the result and what it means.

## Verdict

**Episode retrieval does not clear the stop gate.** The gate is +10 points over *both* baselines.

| regime | vs grep | vs full-context | gate |
|---|---|---|---|
| derived queries | **+40.0** | **−35.0** | **FAIL** |
| oracle-topic queries | **+30.0** | **−2.5** | **FAIL** |

It beats text search decisively and loses to handing the model everything. Same shape as M2:
the architecture's own number does not clear the bar somebody set before seeing it.

## The numbers

40 questions whose answers exist only in 668 MB of real Claude Code transcripts, 3 repeats,
**0.0% variance across every arm and both regimes.** Mechanical grading throughout, never a model
judge; the grader is validated against 23 adversarial answers and 8 positive controls.

**Derived queries** — terms taken from the question text, which paraphrases. The hard, realistic case.

| arm | score | wrong | tokens/question | ms |
|---|---|---|---|---|
| grep | 22.5% | 77.5% | 19,263 | 1,418 |
| full-context | **97.5%** | 2.5% | 72,633 | 0 |
| datum | 62.5% | 37.5% | **11,939** | 32 |

**Oracle-topic queries** — the retrieval ceiling, queries given the right topic words.

| arm | score | wrong | tokens/question | ms |
|---|---|---|---|---|
| grep | 65.0% | 30.0% | 16,506 | 1,292 |
| full-context | **97.5%** | 2.5% | 72,633 | 0 |
| datum | 95.0% | **0.0%** | **10,164** | 11 |

Two things survive the failed gate. At its ceiling datum is **2.5 points behind full-context with
zero wrong answers against its 2.5%**, and it gets there on **7.1× less context** — 10,164 tokens
against 72,633. The gap between 62.5% and 95.0% is entirely query formulation, not storage: the
same corpus, the same index, different words in the query.

## What actually matters here, and it is not the score

The benchmark found a defect worth more than the number.

**A human pasting the agent's words is stored as the human's testimony.** Measured: **23 of 550
human utterances carry 83.4% of the corpus by volume**, and every one is machine-authored prose
arriving in the user's slot. One of them quotes an invented *"9,000 GPU instructions issued per
token"*, and the live API returned it as `role=human actor=human:jish`.

That is the failure mode this project exists to prevent — a customer audit of a competing memory
product found 10,134 entries, 97.8% junk, including 808 copies of one hallucinated preference from
a recall-then-re-extract loop. Here there is a person in the middle of the loop instead of an
extractor, and **attribution cannot see it**: the actor is correct, he did type it, and the
provenance is wrong in every sense that matters.

Three detectors now run at ingest, and rows are **labelled, not dropped** — the human really did
say it, and the act of quoting is part of the record:

| signal | catches | why the others miss it |
|---|---|---|
| `machine_prose` | pasted tables, box drawing, arrow runs, bulleted bold | a table the agent never said has no verbatim counterpart |
| `quoted_from_agent` | the 24,726-char prose paste | no table, no arrow, no heading anywhere in it |
| `echoes_agent_verbatim` | the 203-char case the benchmark named | too short to judge statistically |

`recall` prints `RELAYED-AGENT-PROSE` over MCP and the CLI, so *"Jish decided X"* is
distinguishable from *"Jish pasted the agent saying X"*. 10 of 542 episodes flagged, 53.0% of the
corpus by volume.

**The compaction-summary exclusion turned out to be load-bearing for correctness rather than
tidiness.** It was added to stop a 21k-character document outranking real sentences. It also means
the benchmark's B200 decoy — which reaches the human corpus only inside two `/compact` summaries —
is invisible to datum. full-context fails that trap; datum passes it for exactly that reason.

## Four defects in the instrument, found and fixed before the result was believed

1. **The runner sent all query terms as one AND-query** while grep got each term separately and
   unioned the hits. datum abstained on 28 of 40 and scored 15.0%. Same OR semantics now, and
   `grade.md` records that the fix raised its score.
2. **Bare numeric forbid tokens matched anything.** `85` appears nowhere in the corpus, yet a trap
   forbidding it read as contaminated — the real hits were list indices and unrelated figures
   (`est bake 44 layers`, `85 unmeasured claims`, `was at 48 gb`). Forbid matching is anchored to
   its subject now. Corrected traps: **datum 4/4, full-context 3/4, grep 2/4–3/4.**
3. **Abstention was being credited for words that came from the corpus.** "I don't know" is
   something Jish says, so arms were scored for refusals they never made — 10 rows across both
   regimes.
4. **Agent turns under 200 characters never entered the quote-back index**, so quoting a *short*
   agent claim — `throughput is 757.5 tok/s`, the shape that most reads as a fact — was invisible.
   A test caught it; the floor is 80.

Every one of those four made a number look better or worse than the truth, and none was caught by
a test. All four were caught by re-deriving the number.

## Honest limits

- **Token matching cannot see polarity.** *"He never said 90+ quality"* grades as correct.
  `verify.mts` asserts this still reproduces so it cannot rot into a silent bug.
- **n = 40, and the question set was written in this effort.** The same conflict of interest §16 of
  `HANDOFF.md` warns about. The grader was validated adversarially to limit it, not remove it.
- **8 of 40 answers are `only_in_transcript`** — computed, not asserted, by scanning 1,746 tracked
  files and running `git log -S` on the rarest expected token. The first hand labelling guessed 10
  and the machine found 1.
- **A quarter of derived-regime hits come back via the trigram tier**, which stops firing entirely
  once queries use real words. The fuzzy tier is covering paraphrase and doing it badly. That is
  the most likely place to find the missing 32.5 points, and it is unexplored.
