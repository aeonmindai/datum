# Episode retrieval — four arms, two question sets, three repeats

Grading rules: `grade.md` §2–§7 (unchanged), arms §8, the fourth arm and the second set §10 (appended
before this run — see "What moved in `grade.md`" at the end; no previously published score moved).
Answerer `evidence`, regime `derived` unless stated. 40 questions per set, 3 repeats per cell, 542
episodes, corpus 550 human utterances / 264,103 bytes. No arm errored: `arm_errors` is `{}` in all
four result files.

Result files (one per set × regime):
`results-tuned-derived.json`, `results-heldout-derived.json`,
`results-tuned-topic.json`, `results-heldout-topic.json`.

---

## 1. The gate, on the held-out set. It fails.

**`datum-recall` scores 85.0% on the held-out set. The gate is +10 over both baselines. It is 47.5
points over `grep` (37.5%) and 10.0 points *under* `full-context` (95.0%). It needs 105.0% to pass.
It does not pass, and it is not close: it is 20 points short of the bar against `full-context`.**

The rebuild is not worthless — against the arm it replaces, the old `datum` arm at 75.0%, it is
+10.0 points on held-out at 37% fewer tokens per question. But on the tuned set that same comparison
is +30.0 points. **Two thirds of the measured improvement does not survive a question set the code
was not designed against.**

| held-out, derived | accuracy | vs `datum-recall` |
|---|---|---|
| `full-context` | 95.0% | **+10.0 over datum-recall** |
| `datum-recall` | 85.0% | — |
| `datum` (old arm) | 75.0% | −10.0 |
| `grep` | 37.5% | −47.5 |

Repeat standard deviation is 0.0% for every arm on both sets — every arm is deterministic here, so
none of these margins is inside the noise. The 10-point loss to `full-context` is real.

Two things `datum-recall` does win outright on held-out, and they are not accuracy:

- **Cost.** 7,817 est. tokens/question against `full-context`'s 72,633 — a 9.3× reduction, 312,679
  tokens total against 2,905,320. `full-context` buys its 95.0% by paying for the whole corpus on
  every question; it is the ceiling, not a retrieval system.
- **Traps.** 4/4 on held-out against `full-context`'s 2/4, and 50.0% contamination against 82.5%.
  `full-context` cannot abstain, because everything is always in front of it.

Neither is what the gate asked for. The gate asked for accuracy and the answer is no.

## 2. Four arms × two sets

`derived` regime — query terms from the question text only; `datum-recall` gets the raw question.
`sd` is the standard deviation of accuracy across the 3 repeats; `ms sd` across the 3 repeat means.

| set | arm | accuracy | sd | wrong | abstain | traps | contam | tok/q | ms/q | ms sd |
|---|---|---|---|---|---|---|---|---|---|---|
| tuned | `grep` | 22.5% | 0.0% | 77.5% | 0.0% | 50.0% | 10.0% | 19,263 | 1397.5 | 1.9 |
| tuned | `full-context` | **97.5%** | 0.0% | 2.5% | 0.0% | 75.0% | 10.0% | 72,633 | 0.0 | 0.0 |
| tuned | `datum` | 62.5% | 0.0% | 37.5% | 0.0% | 100.0% | 5.0% | 11,939 | 30.8 | 0.2 |
| tuned | `datum-recall` | 92.5% | 0.0% | 7.5% | 0.0% | 100.0% | 5.0% | **4,330** | 17.1 | 0.1 |
| **heldout** | `grep` | 37.5% | 0.0% | 62.5% | 0.0% | 0.0% | 47.5% | 19,207 | 1249.2 | 1.2 |
| **heldout** | `full-context` | **95.0%** | 0.0% | 5.0% | 0.0% | 50.0% | 82.5% | 72,633 | 0.0 | 0.0 |
| **heldout** | `datum` | 75.0% | 0.0% | 25.0% | 0.0% | 100.0% | 60.0% | 12,477 | 23.2 | 0.6 |
| **heldout** | `datum-recall` | 85.0% | 0.0% | 15.0% | 0.0% | 100.0% | 50.0% | **7,817** | 20.7 | 0.3 |

`full-context`'s 0.0 ms is in-memory string concatenation and nothing else. It is not free — the
72,633 tokens are the cost, and they are in the table.

The `topic` regime, for completeness. It is an **oracle-topic upper bound** for `grep`,
`full-context` and `datum` (§8): their query terms are lifted from the ground-truth utterance.
`datum-recall` sends the raw question in every regime by design (§10.1), so its `topic` column is
**identical to its `derived` column and is not an upper bound**. In this regime the other arms are
handed ground truth and `datum-recall` is not; read it as a stress test, not a comparison.

| set | arm | accuracy | sd | wrong | abstain | traps | tok/q | ms/q | ms sd |
|---|---|---|---|---|---|---|---|---|---|
| tuned | `grep` (oracle) | 65.0% | 0.0% | 30.0% | 5.0% | 75.0% | 16,506 | 1278.3 | 9.1 |
| tuned | `full-context` | 97.5% | 0.0% | 2.5% | 0.0% | 75.0% | 72,633 | 0.0 | 0.0 |
| tuned | `datum` (oracle) | 95.0% | 0.0% | 0.0% | 5.0% | 100.0% | 10,164 | 11.3 | 0.7 |
| tuned | `datum-recall` (raw question) | 92.5% | 0.0% | 7.5% | 0.0% | 100.0% | 4,330 | 17.8 | 0.4 |
| heldout | `grep` (oracle) | 50.0% | 0.0% | 47.5% | 2.5% | 100.0% | 16,261 | 1082.6 | 11.0 |
| heldout | `full-context` | 95.0% | 0.0% | 5.0% | 0.0% | 50.0% | 72,633 | 0.0 | 0.0 |
| heldout | `datum` (oracle) | 95.0% | 0.0% | 2.5% | 2.5% | 100.0% | 9,872 | 11.0 | 2.1 |
| heldout | `datum-recall` (raw question) | 85.0% | 0.0% | 15.0% | 0.0% | 100.0% | 7,817 | 21.3 | 1.1 |

Given the ground-truth query, the *old* `datum` arm reaches 95.0% on held-out at 9,872 tokens. The
whole value of `datum-recall` is that it gets to 85.0% from the raw question, with no oracle. That is
the honest framing of what the rebuild bought and it is smaller than the tuned table suggests.

## 3. Tuned vs held-out, and how much of the gain is overfitting

| | tuned | held-out | delta |
|---|---|---|---|
| `grep` | 22.5% | 37.5% | **+15.0** |
| `full-context` | 97.5% | 95.0% | −2.5 |
| `datum` | 62.5% | 75.0% | **+12.5** |
| `datum-recall` | 92.5% | 85.0% | **−7.5** |
| `datum-recall` − `datum` | +30.0 | +10.0 | — |

**The held-out set is easier for both untuned lexical arms and harder only for the arm that was
tuned.** `grep` gains 15.0 points crossing to held-out and the old `datum` arm gains 12.5.
`datum-recall` is the single arm that loses ground, −7.5. That pattern is the overfitting signature
and there is no reading of it that flatters the rebuild: on a set of matched difficulty, the arms
that never saw a failure list went up and the arm that was built from one went down.

The clean statement of the gain: **+30.0 points over `datum` on the set the code was tuned against,
+10.0 on the set it was not. 20 of those 30 points were tuning.**

How much of the −7.5 is composition rather than generalisation? The mechanism the rebuild leans on is
date reading, so the obvious confound is how often each set names a time. Measured:

- The date reader fires on **30/40** tuned questions and **16/40** held-out questions.
- It fires on **exactly** the questions containing a date-ish phrase, in both sets: 0 misses,
  0 false fires. The reader itself generalises perfectly; the sets differ in what they ask.
- Stratified accuracy: tuned 93.3% dated (28/30) / 90.0% undated (9/10); held-out 87.5% dated
  (14/16) / 83.3% undated (20/24).
- Re-weighting the held-out per-stratum rates onto the tuned set's 30/40 dated composition gives
  **86.5%**, against the tuned 92.5%.

So composition accounts for about **1.5 points** of the 7.5. **The remaining ~6 points is a real
generalisation gap** — `datum-recall` is about 6 points worse on unseen questions of the same kind,
dated or not, and that is after giving the date reader full credit for generalising.

## 4. Tier breakdown for `datum-recall`

`episode_tiers` counts retrieved episodes; `answer_tiers` counts answerable questions whose answer
was present, attributed to the strongest single tier that carried it alone; `window_only` counts
those whose answer disappears when every `window`-tier episode is removed (§10.1). Identical in both
regimes, because this arm sends the same thing in both.

| | tuned | held-out |
|---|---|---|
| episodes: `term+window` | 62 | 48 |
| episodes: `term` | 112 | 254 |
| episodes: `window` | 376 | 153 |
| answers via `term+window` | 19 | 9 |
| answers via `term` | 5 | 16 |
| answers via `window` | 8 | 5 |
| answers via `combined` (no single tier) | 1 | 0 |
| answers present at all (of 36 answerable) | 33 | 30 |
| **`window_only` — answer present ONLY because the question named a time** | **9 / 36** | **5 / 36** |

**The window mechanism carries 5 of 36 answerable held-out questions — 13.9%, against 25.0% on the
tuned set.** All 5 held-out and all 9 tuned `window_only` questions had a genuinely parsed
`plan.window`; none is an artifact of a null window. Held-out `window_only` questions: H13, H27, H28,
H37, H39. Tuned: E06, E19, E20, E23, E24, E27, E32, E33, E35.

That is the honest size of the headline feature: without it, held-out accuracy would fall 5
questions, from 85.0% to 72.5%, and the tuned figure would fall 9 questions, from 92.5% to 70.0%.
**The feature is worth 22.5 points on the set it was designed against and 12.5 points on the set it
was not.** It is the single largest contributor to `datum-recall`'s score and it too is worth roughly
half as much off the tuned set.

## 5. Traps, all four arms, both sets

4 traps per set — questions the corpus does not answer. `correct` = abstained; `wrong+contam` = the
arm surfaced a forbidden value the assistant said and the human never did.

| arm | tuned (E37–E40) | | held-out (H21/H22/H32/H40) | |
|---|---|---|---|---|
| `grep` | 2/4 | E37 wrong+contam, E38 wrong+contam, E39 ok, E40 ok | **0/4** | all four wrong+contam |
| `full-context` | 3/4 | E37 ok, E38 ok, E39 ok, E40 wrong+contam | 2/4 | H21 ok, H22 wrong+contam, H32 wrong+contam, H40 ok |
| `datum` | **4/4** | all abstained | **4/4** | all abstained |
| `datum-recall` | **4/4** | all abstained | **4/4** | all abstained |

Both datum arms are clean on all 8 traps across both sets. `grep` is 0/4 on held-out — the held-out
traps are drawn from neighbourhoods where the tempting value sits close to matching vocabulary, which
`grep`'s four-term union walks straight into. In the `topic` regime `grep` recovers to 4/4 held-out
and drops to 3/4 tuned; `full-context` is 3/4 tuned and 2/4 held-out there; both datum arms stay 4/4.

## 6. The six the held-out set costs `datum-recall`, with the server's note

All six are `wrong` under §8 evidence mode (non-empty context, answer absent, no abstention phrase).
For each I checked whether the source utterance is reachable at all by re-querying `/v1/recall` at
`limit` 12, 40 and 100.

**H03** — *"Jish pushed back on the batch-1 throughput figure with a number he remembered. What was
it?"* · expect `16.57` · source `but we aren't 16.57 on b1?`
`note: terms batch-1(7.295) remembered(6.602) figure(6.197) jish(5.504) pushed(5.349) back(5.098)`
Source rank: **ABSENT at limit 12, 40 and 100.** No window (the question names no time), and the
source utterance shares not one content word with the question — it says `b1`, the question says
`batch-1`; it says nothing resembling "throughput", "figure" or "remembered". Unreachable by this
design at any limit. Diagnosis: pure vocabulary gap with no temporal handle. The window tier is
exactly the mechanism that would rescue this and it cannot fire.

**H08** — *"…hours had been lost waiting on a login. Jish corrected it — what two durations…"* ·
expect `3.6`, `15` · source `brah its not 3.6 hours doing nothing it took 15 mins plus I logged in`
`note: terms login(7.295) against(5.909) lost(5.686) corrected(5.686) jish(5.504) said(5.349); absent from corpus: durations`
Source rank: **ABSENT at 12, 40 and 100.** The question's rarest term is `login`; the corpus writes
`logged in`. There is no stemming and no morphological folding, so the single term that would have
found this record scores 7.295 idf and matches nothing. Diagnosis: no stemmer. This is a one-token
fix away from a hit and it is the most actionable of the six.

**H10** — *"About half an hour later Jish dropped that per-layer target and replaced it with a
range…"* · expect `30`, `42`, `60` · source `forget the 30s thing … 42-60s per layer`
`note: terms replaced(7.295) half(6.602) range(6.197) jish(5.504) dropped(5.504) later(5.349); absent from corpus: per-layer`
Source rank: **ABSENT at 12, reachable at rank 15 (term tier) at limit 40 and 100.** Two failures
compounding: the temporal expression is *relative* ("about half an hour later", anchored on the
previous question, which this arm never sees) so the date reader correctly finds nothing; and the
answer then sits at rank 15 with `limit=12`. Diagnosis: relative-time phrases are not resolved, and
the default limit truncates a hit the ranker did find.

**H23** — *"Late on 14 Aug Jish shelved one geometry change but asked for it to be written down…"* ·
expect `v=4`, `document`, `cheapest`
`note: window 2026-08-14 (whole day); terms asked(6.602) geometry(5.909) written(5.909) jish(5.504) change(4.656) late(4.351); absent from corpus: shelved`
Source rank: **ABSENT at 12, rank 23 (window tier) at 40 and 100.** The date reader did its job —
"Late on 14 Aug" resolved to the whole of 14 Aug, and the source is inside it. It then read the whole
day as one flat window and 22 episodes outranked the right one. Diagnosis: "late on" is read as
*whole day* rather than as the late part of it, so the window is ~4× wider than the question asked
for, and `limit=12` cuts it off. This is the clearest fixable loss in the set.

**H31** — *"Which two GPU architectures did Jish tell the agent to write for whenever it wrote
code?"* · expect `hopper`, `blackwell`
`note: terms whenever(7.295) architectures(6.602) wrote(6.602) jish(5.504) write(5.098) tell(4.3)`
Source rank: **ABSENT at 12, rank 26 at 40 and 100.** No time named, so no window. The question's
whole content is `architectures`; the utterance names the architectures and never uses the word.
Diagnosis: the same vocabulary gap as H03 and H08 — a question that abstracts over its answer's
vocabulary has nothing lexical to grab, and no date to fall back on.

**H38** — *"On the morning of 24 Aug Jish asked for a handoff. What had happened to the credits, and
what did he want the new session to carry on in?"* · expect `credits`, `worktrees`, `branches`
`note: window 2026-08-24 morning (5:00-13:00); terms asked(6.602) carry(6.602) credits(6.197) jish(5.504) new(4.897) handoff(4.405)`
**Retrieval succeeded and the grader lost it.** The source utterance is returned at **rank 1 and
rank 2** (`tier=term+window`, score 12.77) and the retrieved context contains
`the same worktrees/branches` verbatim. §3 keeps `/` inside a token, so the corpus token is
`worktrees/branches`; §3's token test is a **prefix** test, so `worktrees` hits and `branches`
cannot. Verified mechanically: **H38 is the only question in either set whose own source utterance
does not satisfy every one of its `expect` entries under `grade.mts`** — 0/40 on the E set (which
`verify.mts` enforces as §9 rule 5), 1/40 on the held-out set. `HELDOUT.md` §2 asserts this property
was checked, but with a substring-based matcher rather than `grade.mts`'s tokeniser, so the defect
survived.

Two arms "pass" H38 and both do so spuriously: standalone `branches` occurs in 7 utterances, 4 of
which are `/compact` pastes. `full-context` scores it from those pastes; `datum` scores it from an
unrelated later utterance its `handoff` term pulled in. **No arm matched `branches` in the record the
question is about.**

I did not change §3 to fix this. Widening `/` to a separator would break `tok/s` and `v=4`, and
loosening the prefix test to a substring test in order to raise the score of the arm under test —
after seeing which question it cost — is the exact failure mode this whole exercise exists to catch.
So the headline stays **85.0%**. If H38 is treated as a set defect and dropped, `datum-recall` is
87.2% (34/39) and `full-context` 94.9% (37/39): the gate would need 104.9% and still fails by 17.7
points. Nothing here turns on it.

**Diagnosis, summed.** Of six held-out losses: **two are unreachable at any limit** (H03, H08 — no
shared vocabulary, no date), **three are ranking-and-limit losses** the ranker already solves at
`limit=40` (H10 r15, H23 r23, H31 r26), **one is a grading defect on a question that was retrieved
perfectly** (H38). Raising the default `limit` from 12 to 40 would recover 3 of 6 — but it would also
roughly triple the token bill on the term path, and the 12-vs-40 choice was itself made while looking
at the tuned set, so I am reporting it as a diagnosis and not running it as a result. The genuinely
unfixed capability gaps are morphology (H08 `login`/`logged in`), relative time (H10 "half an hour
later"), sub-day window resolution (H23 "late on"), and abstractive questions with no temporal handle
(H03, H31).

## 7. Reproducing this

```
export DATUM_BASE_URL=http://127.0.0.1:8479
export DATUM_TOKEN=$(cat /tmp/b2key.txt)
npx tsx bench/episodes/run.mts --repeats=3                                        # tuned,   derived
npx tsx bench/episodes/run.mts --repeats=3 --questions=questions-heldout.json      # heldout, derived
npx tsx bench/episodes/run.mts --repeats=3 --query=topic                           # tuned,   topic
npx tsx bench/episodes/run.mts --repeats=3 --query=topic --questions=questions-heldout.json
```

Defaults: `--arms=grep,full-context,datum,datum-recall`, `--recall-limit=12`, `--datum-limit=20`,
`--answerer=evidence`. Env: `DATUM_BASE_URL`, `DATUM_EPISODES_PATH`, `DATUM_RECALL_PATH`,
`DATUM_SCOPE`, `DATUM_TOKEN`.

Nothing in `src/`, `migrations/`, `questions.json`, `questions-heldout.json` or `HELDOUT.md` was
touched. The server was not restarted or re-ingested.

## 8. What moved in `grade.md`, and what it did to the scores

`grade.md` §10 was appended **before** the four scored runs. **No score moved**, because no grading
rule changed: §2–§7 are untouched, `grade.mts` is untouched, `evidence` mode and `forbid` handling are
untouched, and all four arms on both sets are scored by the same binary. §10 adds (a) the
`datum-recall` arm's contract and its one asymmetry — it sends the raw question in every regime,
which costs it the oracle query in `topic` and is labelled wherever that column appears; (b)
`--questions=`, the `results-<set>-<regime>.json` naming, and the standing requirement to label tuned
numbers as contaminated; (c) the `answer_tiers` / `window_only` attribution, both computed with the
existing §3 matcher; (d) the gate, written down as +10 over both baselines on the held-out set in
`derived` under `evidence`.

Three measurement caveats found while running, none of which changes a number above:

1. **`--recall-limit` does not bound the window path.** When the window fallback fires, the server
   returns the whole window regardless of `limit` — up to 48 episodes on E19, 13.8 episodes/question
   mean on the tuned set against the nominal 12. Token cost is therefore not capped by `limit`, and
   the tuned set's low 4,330 tok/q is short *window* utterances, not a tighter result set.
2. **`tier: "window"` does not imply a date was parsed.** At limits above the term-tier hit count the
   server labels filler episodes `window` even when `plan.window` is `null` (seen on H10 and H31 at
   `limit=40`). At the benchmark's `limit=12` this never occurred: all 14 `window_only` answers across
   both sets had a real parsed window, so the §4 counts are clean. The label is looser than the tier
   name suggests and should not be read as "date-selected" without checking `plan.window`.
3. **`verify.mts` has not been pointed at the held-out file.** §9's assertions for that set exist only
   as transcribed output in `HELDOUT.md`, which is how the H38 defect got through. That is a weaker
   guarantee than a checked-in test and it cost exactly one question.
