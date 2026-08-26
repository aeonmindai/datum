# Is `full-context` a baseline, or an artefact of a corpus small enough for it to be executable?

`RESULTS.md` §1 fails the episode gate on arithmetic: `full-context` scores 95.0% held-out, the gate
is +10 over both baselines, so the bar is 105.0% and nothing can clear it. This file settles whether
that is a verdict on the product or a verdict on the baseline.

Every number below came out of one command, one 36-second run, on 2026-08-26:

```
cd packages/datum && npx tsx bench/episodes/scale.mts        # writes results-scale.json
```

`scale.mts` reads the corpus only through `bench/episodes/corpus.mts` and scores only through
`bench/episodes/grade.mts`. It touches nothing under `src/` and no existing bench file. Where a
figure is an extrapolation rather than a measurement it says so, here and in the script.

**The run reproduces the published `full-context` arm exactly** — 97.5% tuned / 95.0% held-out,
10.0% / 82.5% contamination, 3/4 and 2/4 traps, 72,633 est. tokens per question — against
`results-tuned-derived.json` and `results-heldout-derived.json`. That agreement is the check that
what follows is measuring the same thing the benchmark measured.

**One row of §2 moves between runs.** `omp:-Documents-GitHub-datum` is this session's own transcript;
it grew by 2 utterances while this report was being written. That row, the `omp:-Documents-GitHub-…`
byte columns, the totals, and the 10-project and whole-machine token counts therefore drift upward by
a few utterances per re-run. Nothing that drifts changes a score: every accuracy, trap and
contamination figure below was identical across four runs spanning that drift.

---

## 1. The asymmetry, exactly. It is tokens only, and it runs the *other* way

| Arc corpus | value |
|---|---|
| human utterances with text | 550 |
| `[Request interrupted…]` markers | 49 |
| `/compact` continuation summaries (`pasted`) | 8 |
| episodes Datum stores | 542 |
| text chars, all 550 | 253,912 |
| text chars, the 8 compaction summaries | 151,752 |
| text chars, the 542 stored | 102,160 |
| `full-context` payload | 290,530 chars / **72,633** est. tokens |
| the same payload built from only the 542 | 138,239 chars / **34,560** est. tokens |
| compaction share of the payload | **52.4%** |

`full-context` is billed for **2.10×** the material Datum will accept. The question is whether any of
those extra bytes carry an answer.

### Answerability, both directions

Scored the way `grade.mts` scores: an answerable question is reachable from a corpus when every
`expect` entry matches somewhere in the payload that arm is handed.

| set | answerable | reachable from both | **reachable from 550 only** | **reachable from 542 only** | reachable from neither | traps |
|---|---|---|---|---|---|---|
| tuned | 36 | 36 | **0** | **0** | 0 | 4 |
| held-out | 36 | 36 | **0** | **0** | 0 | 4 |

**Zero in both directions, on both sets.** All 72 answerable questions are reachable from the 542
episodes and from the 550 utterances alike. Corroborating counts, same run:

- `expect` entries matched by no stored episode and by at least one compaction summary: **0 of 152**
  (83 tuned, 69 held-out). The pastes carry no answer token the stored episodes do not.
- Record level ("some *single* record satisfies every `expect`"): one asymmetry, **E35** (tuned). Its
  three entries — `2000 word essay`, `256`, `200` — sit together inside one compaction summary and
  are spread across separate stored episodes. Both corpora satisfy it at set level, which is what is
  scored. Nothing in the other direction, either set.

**The asymmetry is in tokens, not in answerability.** That is the answer to step 1, and it removes the
most convenient excuse available for the 10-point loss.

### And correcting it makes `full-context` *better*

The same arm, same grader, scored over each payload:

| set | payload | accuracy | answerable | traps | contamination |
|---|---|---|---|---|---|
| tuned | all 550 | 97.5% | 36/36 | 3/4 | 10.0% |
| held-out | all 550 | 95.0% | 36/36 | 2/4 | 82.5% |
| tuned | the 542 Datum stores | **100.0%** | 36/36 | **4/4** | 7.5% |
| held-out | the 542 Datum stores | **97.5%** | 36/36 | **3/4** | 70.0% |

Feeding `full-context` only what Datum accepts costs it nothing and gains it 2.5 points on each set,
entirely on traps. **E40** and **H22** are contaminated *only* when the compaction summaries are
present, and by nothing else in the corpus: E40 forbids `55` and `26000` anchored on
`b200`/`b300`/`aggregate`, H22 forbids `Apache-2.0`/`BSL-1.1`/`MIT` anchored on `licence`. In both
cases the tempting value is in the model's own summary prose and in no human utterance. Measured on
this corpus, the `includeAgent: false` exclusion is worth **+1 trap per set** to whoever obeys it —
an argument for the contract, not a handicap imposed by it.

The consequence for the gate runs against Datum: a fairly-fed `full-context` scores 97.5% held-out,
so the bar becomes **107.5%** and `datum-recall`'s deficit becomes **12.5 points**, not 10.0. Nothing
about the asymmetry rescues the product.

## 2. The corpus that actually exists

`corpus.mts`'s definition of a human utterance, applied unchanged to every project directory under
`~/.claude/projects` and `~/.omp/agent/sessions`. Flat `.jsonl` only, because that is what
`transcriptFiles()` reads — the nested files are subagent transcripts whose `user`-role records are
task prompts written by an orchestrating model, which the contract excludes on principle. `payload
tok` is the est. token cost of a `full-context` arm over that project alone.

| project | flat files | nested files | flat MB | nested MB | utterances | interrupts | text chars | payload tok | span |
|---|---|---|---|---|---|---|---|---|---|
| `claude:…GitHub-arc` | 6 | 519 | 89.3 | 557.7 | 550 | 49 | 253,912 | 72,633 | 2026-08-10 .. 2026-08-24 |
| `claude:…GitHub-wambo` | 3 | 209 | 269.8 | 95.2 | 402 | 78 | 173,165 | 49,169 | 2026-07-24 .. 2026-08-12 |
| `claude:-Users-jish` | 8 | 48 | 56.3 | 51.1 | 318 | 78 | 301,502 | 79,730 | 2026-07-21 .. 2026-08-26 |
| `claude:…echos-backend--claude-worktrees-bridge-cse` | 1 | 45 | 288.2 | 16.6 | 291 | 57 | 151,633 | 43,334 | 2026-07-11 .. 2026-08-13 |
| `claude:…GitHub-echos-backend` | 1 | 100 | 29.8 | 293.0 | 156 | 20 | 102,986 | 28,862 | 2026-06-25 .. 2026-08-14 |
| `claude:…GitHub-aeonmind` | 1 | 31 | 26.2 | 9.9 | 137 | 31 | 73,375 | 20,226 | 2026-05-14 .. 2026-05-21 |
| `omp:-Documents-GitHub-datum` *(live)* | 2 | 25 | 11.7 | 26.2 | 58 | 0 | 14,454 | 4,205 | 2026-08-24 .. 2026-08-26 |
| `omp:-Documents-GitHub-aeonmind` | 2 | 89 | 7.6 | 93.3 | 51 | 0 | 6,441 | 2,128 | 2026-08-23 .. 2026-08-26 |
| `omp:-Documents-GitHub-arc` | 2 | 14 | 2.9 | 13.2 | 39 | 0 | 19,941 | 5,381 | 2026-08-22 .. 2026-08-24 |
| `omp:--private-tmp--` | 5 | 10 | 2.3 | 3.5 | 24 | 0 | 23,465 | 6,107 | 2026-08-22 .. 2026-08-23 |
| `claude:…superconductor-worktrees-echos-backend-sc-coupled-yttrium-9590` | 3 | 0 | 0.2 | 0.0 | 4 | 1 | 189 | 122 | 2026-08-12 .. 2026-08-12 |
| 12 further project directories | 2 | 0 | 0.0 | 0.0 | 0 | 0 | 0 | 0 | — |
| **TOTAL — 23 project directories** | **36** | **1,090** | **784.3** | **1,159.7** | **2,030** | **314** | **1,121,063** | **311,898** | 2026-05-14 .. 2026-08-26 |

Reconciling that against the 1.94 GB on disk:

- All `.jsonl` under both roots: **1,126 files, 1.94 GB.** The byte figure matches the brief exactly.
- Of it, **1,090 files and 1,160 MB are nested subagent transcripts** `corpus.mts` never opens. The
  36 files it does open are 784.3 MB.
- Those 784.3 MB yield **1,121,063 chars of human speech — 0.143% of the bytes it opens, 0.058% of
  the 1.94 GB.** The entire human corpus on this machine is **311,898 est. tokens**, **4.29×** Arc's.
- Arc's own directory holds 525 `.jsonl` totalling 646,950,081 bytes, of which **86.2% is nested
  subagent prose**; the six files `corpus.mts` reads are 89.3 MB.

**One finding that is a defect, not a measurement.** `corpus.mts` tests the outer envelope
`type === "user"`. omp writes `{type:"message", message:{role:"user"}}`. Run natively against
`~/.omp/agent/sessions`, `corpus.mts` returns **0 human utterances from all five omp project
directories** — 156 MB and 172 utterances invisible. The omp rows above were produced by rewriting
only that envelope and handing the untouched `message` back to `corpus.mts`, so every rule that
decides whether text counts (`isMeta`, `tool_result`, `<…>` wrappers, interrupt markers, the
`/compact` flag) still lives in the one file allowed to decide it. No second definition of a human
utterance exists in `scale.mts`.

## 3. Where `full-context` stops being possible. It does not, yet

Tokens per question for a `full-context` arm are just its payload — it hands over the whole corpus on
every question. `$/1k q` is at $3/M input tokens, payload only.

| corpus | projects | utterances | tokens/question | fits 200k | fits 1M | $/1,000 questions |
|---|---|---|---|---|---|---|
| 1 project (Arc — the benchmark's corpus) | 1 | 550 | 72,633 | yes | yes | **$217.90** |
| 10 projects (the ten largest) | 10 | 2,026 | 311,776 | **NO** | yes | **$935.33** |
| everything (both roots) | 11 | 2,030 | 311,898 | **NO** | yes | **$935.69** |
| `datum-recall` (retrieves) | — | — | **7,817** | yes | yes | **$23.45** |

Datum's row is flat because it retrieves: 7,817 is the measured held-out mean from
`results-heldout-derived.json`, and what bounds it is scope, `limit` and window width — none of which
is corpus size. Two honesties about that row. It is **not** corpus-independent by measurement: I did
not ingest ten projects and did not re-run the server, so its constancy across the three rows is
architecture plus `RESULTS.md` §8.1's caveat that the window path is not bounded by `limit`, not an
observation. And the cost advantage is **9.29×** at Arc scale, **39.90×** at whole-machine scale.

Where the windows actually break, projects added largest-first — the *fewest* projects that can break
a window, which is the friendliest possible reading of the claim that `full-context` stops working:

```
1:79,730  2:152,363  3:201,532  4:244,865  5:273,728  6:293,954
7:300,061  8:305,442  9:309,648  10:311,776  11:311,898
```

**A 200k window is exceeded at three projects. A 1M window is never exceeded on this machine.** The
corpus spans 2026-05-14 to 2026-08-26 — 104 days at 2,999 est. tokens/day. *Extrapolation, at that
rate and nothing else:* 1M is crossed around day 334, roughly seven more months of the same working
pattern. **"full-context becomes impossible" is false today.** It becomes 4.29× dearer and it stops
fitting the window most production deployments actually run on.

### What growing the corpus does to the score

`grade.mts` in `evidence` mode makes this predictable before it is run, and running it confirms it:
an answerable question's verdict is `expectSatisfied(payload)`, which cannot fall as the payload
grows, and a trap's is `!forbidTrips(payload)`, which cannot rise.

| corpus | set | accuracy | answerable | traps | contamination |
|---|---|---|---|---|---|
| 1 project | tuned | 97.5% | **36/36** | 3/4 | 10.0% |
| 1 project | held-out | 95.0% | **36/36** | 2/4 | 82.5% |
| 10 projects | tuned | 97.5% | **36/36** | 3/4 | 10.0% |
| 10 projects | held-out | **92.5%** | **36/36** | **1/4** | **87.5%** |
| everything | tuned | 97.5% | **36/36** | 3/4 | 10.0% |
| everything | held-out | **92.5%** | **36/36** | **1/4** | **87.5%** |

`full-context` is already at **36/36 on answerable questions at Arc scale, on both sets.** It cannot
improve and it never does. Every point it is missing is a trap, and traps are the one component that
moves — downward: held-out traps 2/4 → 1/4, contamination 82.5% → 87.5%, accuracy 95.0% → 92.5%,
purely from adding ten projects of unrelated speech. **In `evidence` mode `full-context` is not
measuring retrieval. It is a corpus-coverage meter that is already saturated, plus a contamination
counter that gets worse with scale.**

### The baseline the gate should have used

`full-context` is not a different policy from `datum-recall`. It is the same "put the corpus in the
prompt" policy with the budget removed, and a system spending 7,817 tokens a question is being asked
to beat one spending 72,633. Restoring the budget and keeping the policy every chat client actually
implements — the newest turns that fit — gives a real no-retrieval baseline. Same corpus, same
grader, same 7,817-token budget:

| corpus | utterances kept | set | accuracy | answerable | traps | contamination |
|---|---|---|---|---|---|---|
| 1 project (Arc) | 67 | tuned | 25.0% | 6/36 | 4/4 | 2.5% |
| 1 project (Arc) | 67 | **held-out** | **35.0%** | 10/36 | 4/4 | 42.5% |
| 10 projects | 73 | tuned | 12.5% | 1/36 | 4/4 | 5.0% |
| 10 projects | 73 | **held-out** | **17.5%** | 3/36 | 4/4 | 20.0% |
| everything | 73 | tuned | 12.5% | 1/36 | 4/4 | 5.0% |
| everything | 73 | **held-out** | **17.5%** | 3/36 | 4/4 | 20.0% |

**At equal cost on the corpus the benchmark actually uses, `datum-recall` scores 85.0% and no
retrieval scores 35.0%. That is +50.0 points, clearing +10 five times over.** The 4/4 trap column is
not a virtue: the arm sees 67 of 550 utterances, so it abstains by starvation.

*Extrapolation, labelled:* the same baseline falls to 17.5% at whole-machine scale while a
scope-filtered retrieval's inputs for an Arc-scope question do not change, which would put the gap at
+67.5. I did not re-ingest or re-run the server, so 85.0% at ten-project scale is an assumption, not
a number I ran.

## 4. The verdict

**Not (a). Chiefly (c), and (b) only in a way that does not help.**

The gate is mis-specified, but not for the reason the brief proposes. It is not that the corpus is
too small for `full-context` to be a fair opponent — it is that **`full-context` is not a baseline at
any corpus size.** Three measurements from this run, in order of force. Its answerable score is
**36/36 at Arc scale on both question sets**, so it is pinned at the ceiling before the corpus grows
at all, and in `evidence` mode that score is monotone non-decreasing in payload size by construction,
so it can never be lost. Its only moving part is traps, and those move the wrong way — **2/4 to 1/4**
held-out, contamination **82.5% to 87.5%** — as the corpus goes from 550 to 2,030 utterances. And it
is the same policy as the arm under test with the price tag removed: **72,633 tokens against 7,817,
$217.90 against $23.45** per thousand questions. A gate of "+10 over the ceiling" is unreachable for
any baseline scoring above 90.0%, which is a property of the gate's arithmetic and not a fact about
any system. Restated as retrieval versus no retrieval at equal cost — the comparison a buyer is
actually making — Datum is **+50.0 points** held-out (85.0% against 35.0%) and **+47.5** over `grep`.
Two of the three comparisons clear +10 by wide margins and the third cannot be cleared by anything.

The corpus-size half of the hypothesis, (b), does not survive its own numbers. 1.94 GB of transcripts
contain **311,898 est. tokens** of human speech. `full-context` still fits a 1M window at every scale
on this machine, is pushed out of 200k only at three projects, and by extrapolation survives another
seven months. So the honest form of (b) is narrow: the corpus is small enough that `full-context`'s
**cost** does not bite, which is why a benchmark that measures accuracy finds nothing wrong with it —
not that the corpus is small enough to make it *possible*.

And none of this clears Datum. `datum-recall` loses **10.0 points** to `full-context` on the held-out
set, and **12.5** once the compaction asymmetry is corrected in the direction the measurements
actually point, at 0.0% repeat standard deviation on both sets. Every one of the 72 answerable
questions is reachable from the 542 episodes it holds, so the six held-out losses in `RESULTS.md` §6
are retrieval failures with no coverage excuse behind them — three rank-and-limit losses the ranker
already solves at `limit=40`, two vocabulary gaps with no temporal handle, one grading defect.
Datum's claim to exist rests on getting 85.0% for 7,817 tokens where no retrieval gets 35.0% and
where reading everything costs 9.29× more now and 39.90× more at whole-machine scale. That claim is
supported by the numbers above. The claim that it beats a saturated ceiling by 10 points is not, will
not be, and should never have been written as the gate.

Concretely, the gate I would defend: **+10 over `grep` and +10 over a budget-matched no-retrieval arm,
both on held-out, plus no regression against `full-context` beyond a stated tolerance, with
`full-context` reported as the ceiling it is.** Today that reads **+47.5, +50.0, and −10.0** against a
ceiling: a pass, a pass, and a known six-question defect list.

## 5. What I ran, and what I did not

Ran: `npx tsx bench/episodes/scale.mts` from `packages/datum` (36 s), and
`npx tsc --noEmit --module nodenext --moduleResolution nodenext --target ES2023 --lib ES2023 --strict
--noUncheckedIndexedAccess --verbatimModuleSyntax --skipLibCheck --types node
packages/datum/bench/episodes/scale.mts` — clean. `npx tsc -p packages/datum/tsconfig.json --noEmit`
— clean (`bench/**` is outside its `include`, so that run proves only that nothing under `src/`
moved). Every number in this file is printed by `scale.mts` and stored in `results-scale.json`, except
the one `du` figure in the discrepancy table below, which came from
`du -sk ~/.claude/projects/-Users-jish-Documents-GitHub-arc`.

Did not run: the datum server, any re-ingest, `run.mts`, the full test suite, any linter or
formatter. `datum-recall`'s 85.0% and 7,817 tokens are quoted from `results-heldout-derived.json`,
not re-measured, and no Datum number at multi-project scale is a measurement.

Four figures in the brief did not reproduce, all cosmetic:

| brief | measured | why |
|---|---|---|
| 103,628 chars stored / ~25,907 tokens | **102,160** chars / 25,540 | 253,912 − 151,752 = 102,160 exactly; both component figures match the brief, the 1,468-char difference does not |
| 253,912 chars handed to `full-context` | **290,530** chars | 253,912 is the raw text sum; the payload adds one `[file:line ts branch]` header per utterance |
| 2,072 files, 1.94 GB | **1,126** `.jsonl`, 1.94 GB | bytes match exactly; the file count appears to include the 951 sibling `.json` files (1,126 + 951 = 2,077) |
| Arc: 6 files, 668 MB | 6 files, **89.3 MB** | 668 MiB is `du` over the whole Arc directory — 525 `.jsonl` plus 951 other files; `corpus.mts` reads six of them |
