# Final measurement — three question sets, four arms, current code

**On the clean set `datum-recall` FAILS the gate: it scores 85.0% where the gate requires 102.5%, and
it is 7.5 points BELOW `full-context` (92.5%) rather than 10 above it.**

The gate is `grade.md` §10.3, quoted exactly:

> `datum-recall` passes only by beating **both** `grep` and `full-context` by at least 10 accuracy
> points [...] in the `derived` regime, under `evidence` answering.

Applied to `questions-third.json` — the only set nothing has been read off:

| | accuracy | margin needed | margin achieved |
| --- | --- | --- | --- |
| vs `grep` 22.5% | 85.0% | ≥ 32.5% | **+62.5** pass |
| vs `full-context` 92.5% | 85.0% | ≥ 102.5% | **−7.5** fail |

Beating one baseline is not a pass. `full-context` is the binding baseline and it has been the binding
baseline on every set: the gate fails on the tuned set too (−2.5), and on the burned held-out set
(−7.5). Every margin here is far outside one repeat standard deviation, which is 0.0% in all twelve
cells — every question returned the same verdict in all three repeats, so nothing in this document
rests on a single sample of a noisy quantity.

Measured 2026-08-26 against the live store on `http://127.0.0.1:8481`, scope `org/aeonmind/proj/arc`,
542 episodes, 550 human utterances / 264,103 bytes. `derived` query regime, `evidence` answerer,
3 repeats, 40 questions per set. **No arm errored on any set** (`arm_errors` is empty in all three
results files).

## The twelve cells

| set | arm | accuracy | ±sd | wrong | abstain | traps | trust | contam | tok/q | ms/q | ms sd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tuned (E) | grep | 22.5% | 0.0% | 77.5% | 0.0% | 50.0% | −55.0% | 10.0% | 19,263 | 1686.4 | 2.3 |
| tuned | full-context | 97.5% | 0.0% | 2.5% | 0.0% | 75.0% | 95.0% | 10.0% | 72,633 | 0.0 | 0.0 |
| tuned | datum | 62.5% | 0.0% | 37.5% | 0.0% | 100.0% | 25.0% | 5.0% | 11,939 | 43.4 | 0.7 |
| tuned | **datum-recall** | **95.0%** | 0.0% | 5.0% | 0.0% | 100.0% | 90.0% | 5.0% | 4,070 | 25.7 | 0.4 |
| burned (H) | grep | 37.5% | 0.0% | 62.5% | 0.0% | 0.0% | −25.0% | 47.5% | 19,207 | 1486.7 | 7.4 |
| burned | full-context | 95.0% | 0.0% | 5.0% | 0.0% | 50.0% | 90.0% | 82.5% | 72,633 | 0.0 | 0.0 |
| burned | datum | 75.0% | 0.0% | 25.0% | 0.0% | 100.0% | 50.0% | 60.0% | 12,477 | 32.1 | 1.5 |
| burned | **datum-recall** | **87.5%** | 0.0% | 12.5% | 0.0% | 100.0% | 75.0% | 50.0% | 7,064 | 30.8 | 1.3 |
| clean (T) | grep | 22.5% | 0.0% | 77.5% | 0.0% | 50.0% | −55.0% | 47.5% | 19,048 | 1766.2 | 3.6 |
| clean | full-context | 92.5% | 0.0% | 7.5% | 0.0% | 25.0% | 85.0% | 95.0% | 72,633 | 0.0 | 0.0 |
| clean | datum | 42.5% | 0.0% | 57.5% | 0.0% | 25.0% | −15.0% | 60.0% | 12,717 | 46.7 | 1.6 |
| clean | **datum-recall** | **85.0%** | 0.0% | 15.0% | 0.0% | 50.0% | 70.0% | 47.5% | 4,425 | 27.0 | 0.9 |

`±sd` is the standard deviation of accuracy across the 3 repeats; it is 0.0% in every cell because
retrieval is deterministic and the evidence answerer adds no sampling. `unstable` (questions whose
verdict changed between repeats) is 0 in all twelve cells. Latency is the only quantity that varies,
and its standard deviation is in the last column.

Two honest caveats about columns that flatter someone:

- **`full-context` ms/q is 0.0 by construction, not by merit.** The 72,633-token context is assembled
  once at module load and the arm returns the cached string, so the timer measures a pointer copy. The
  real cost of that arm is the token column: 16.4× `datum-recall` on the clean set (72,633 vs 4,425),
  and 2,905,320 tokens to answer 40 questions.
- **`abstain` is 0.0% everywhere** because in evidence mode an abstention requires an empty result and
  no arm returned zero units on any question. Nothing refused anything; every failure is a wrong.

## The tuning ladder

`datum-recall`, same code, three sets:

| set | status | accuracy | trust | tok/q |
| --- | --- | --- | --- | --- |
| `questions.json` (E) | tuned — code designed against these | **95.0%** | 90.0% | 4,070 |
| `questions-heldout.json` (H) | burned — clean for one run, then two mechanisms built from its failures | **87.5%** | 75.0% | 7,064 |
| `questions-third.json` (T) | clean — nothing read off it | **85.0%** | 70.0% | 4,425 |

**The clean score is below the burned score.** 85.0% vs 87.5%, a drop of 2.5 points, one question.
Said plainly: the progression is monotonically downward with distance from the tuning data —
95.0 → 87.5 → 85.0 — and the total overfit measured between the set the code was written against and
a set it has never seen is **10.0 points**. Contamination is not a small correction here; it is the
difference between a number that looks near-perfect and a number that fails the gate.

### How much of the improvement was real

The previously published tuned/held-out numbers predate `when.ts` and `terms.ts`, so they were re-run,
not quoted. Re-running them on current code, with the earlier files left untouched:

| arm | tuned before | tuned now | burned before | burned now |
| --- | --- | --- | --- | --- |
| grep | 22.5% | 22.5% | 37.5% | 37.5% |
| full-context | 97.5% | 97.5% | 95.0% | 95.0% |
| datum | 62.5% | 62.5% | 75.0% | 75.0% |
| datum-recall | 92.5% | **95.0%** | 85.0% | **87.5%** |

The three baselines are bit-identical before and after, which is the control: the two mechanisms
touched only the `/v1/recall` path, and the +2.5 on each set is theirs.

Per-question, the burned-set delta is **not** what was claimed. The claim carried into this run was
that three of the six diagnosed failures now retrieve (H03, H10, H23). Measured end to end at the
shipped limit of 12:

| question | before | now | reality |
| --- | --- | --- | --- |
| H03 | wrong | **correct** | recovered. `terms.ts` fold `batch-1 -> b1[abbrev](6.566)` appears in the plan and did the work. |
| H23 | wrong | **correct** | recovered. `when.ts` narrowed `2026-08-14 (whole day)` to `"late on" read as 16:00-02:00 next day UTC`. |
| H10 | wrong | wrong | **not recovered.** The claimed `per-layer -> layer` fold does not appear in H10's plan at all; its terms are `replaced half range jish dropped later`. |
| H24 | correct | **wrong** | **a regression.** Its plan lost the term `after(4.897)` that the earlier run had, and gained a duplicate `telling`; the target dropped out of the top 12. |

So the honest arithmetic on the burned set is +2 recovered, −1 regressed, net +1 question = +2.5 points,
against a claim of 3 recovered and "0 regressions". The regression claim was validated on window fire
pattern, which is genuinely unchanged; it was not validated on end-to-end verdicts, and one verdict
moved backwards.

## Temporal stratification — and it does not exonerate the clean set

The window tier can only fire on a question that names a time, and the sets do not name times equally.
Classified by three regexes over the question text alone (date, clock, part-of-day — no ground truth,
no server plan, so a question is classified identically for all four arms), the `any` counts reproduce
the published composition exactly: **30/40 tuned, 16/40 burned, 30/40 clean**, and the clean set's ten
non-temporal ids are exactly THIRD.md's list (T07 T12 T16 T18 T19 T22 T30 T32 T34 T40). Sub-counts
differ slightly from THIRD.md's table (clock 8 vs 7, part-of-day 19 vs 17) because the regexes are not
character-identical; the union, which is the number the stratification uses, agrees on all three sets.

The window actually fired on 30/30 tuned, 16/16 burned, 29/30 clean temporal questions and on **zero**
non-temporal questions in any set. The single miss is T09, whose only time reference is the relative
phrase "the same evening" with no date to anchor it; it was answered correctly by terms anyway.

### Accuracy by stratum, every arm, every set

| set | arm | temporal | non-temporal | re-weighted to 16/40 |
| --- | --- | --- | --- | --- |
| tuned | grep | 13.3% (30q) | 50.0% (10q) | 35.3% |
| tuned | full-context | 100.0% | 90.0% | 94.0% |
| tuned | datum | 53.3% | 90.0% | 75.3% |
| tuned | datum-recall | 96.7% | 90.0% | 92.7% |
| burned | grep | 50.0% (16q) | 29.2% (24q) | 37.5% |
| burned | full-context | 100.0% | 91.7% | 95.0% |
| burned | datum | 68.8% | 79.2% | 75.0% |
| burned | datum-recall | 93.8% | 83.3% | 87.5% |
| clean | grep | 20.0% (30q) | 30.0% (10q) | 26.0% |
| clean | full-context | 100.0% | 70.0% | 82.0% |
| clean | datum | 46.7% | 30.0% | 36.7% |
| clean | **datum-recall** | **96.7%** | **50.0%** | **68.7%** |

`re-weighted to 16/40` places each set's own two strata on the burned set's composition
(40% temporal), which is the least temporal of the three — chosen deliberately, because re-weighting
onto the more temporal composition would be picking the flattering baseline.

### How much is composition

The opposite of the usual story. Composition was **hiding** the clean set's shortfall, not causing it:

| comparison | clean | burned | gap |
| --- | --- | --- | --- |
| raw, all 40 | 85.0% | 87.5% | **−2.5** |
| re-weighted to 16/40 temporal | 68.7% | 87.5% | **−18.8** |
| raw, 36 answerable only | 88.9% | 86.1% | +2.8 |
| answerable, re-weighted to 16 temporal / 20 non-temporal | 70.7% | 86.1% | **−15.4** |

On the raw numbers the clean set looks 2.5 points behind. Matched for composition it is 18.8 points
behind. **Composition accounts for −16.3 points of hidden gap; none of the shortfall is composition and
16.3 points of it were being masked by it.** The reason is visible in the strata: on temporal questions
the clean set is as strong as the tuned set (96.7% both), and on non-temporal questions it collapses to
50.0% against the burned set's 83.3%. The clean set simply asked more of the half where the window
mechanism does nothing, and got graded on a composition that happened to weight that half at 1/4.

Two things must be said about that figure rather than left implicit:

- **The trap confound inside the stratification.** All 12 abstention traps across all three sets are
  non-temporal. On the tuned and clean sets that makes the non-temporal stratum 4/10 traps; on the
  burned set 4/24. Re-weighting the non-temporal stratum up therefore re-weights traps up by 2.4×,
  which is why the answerable-only row is given beside it. On answerable questions only the strata are
  clean-set 96.7% (30q) / 50.0% (6q) against burned-set 93.8% (16q) / 80.0% (20q).
- **n = 6.** The clean set's non-temporal answerable stratum is six questions, of which three are
  correct. One question is 16.7 points, and re-weighting multiplies that stratum's weight by 3.3×.
  The composition-matched figure of 70.7% is therefore the least stable number in this document, and a
  wide interval around it still does not reach `full-context`.

Mirror direction, for completeness: re-weighting the burned set onto the clean set's 30/40
composition gives 91.1% against the clean set's 85.0%, a gap of −6.1. Whichever composition both sets
are placed on, the clean set is behind.

## Tier breakdown, and what the window tier is worth

Episodes retrieved by tier, and answers attributed to the strongest tier that carried them alone
(repeat 0, 40 questions):

| set | term+window | term | window | answers via term+window | via term | via window | window-only answers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tuned | 93 | 117 | 320 | 23 | 5 | 5 | 6 |
| burned | 58 | 268 | 129 | 12 | 15 | 4 | 4 |
| clean | 89 | 126 | 282 | 19 | 4 | 9 | 9 |

The clean set leans on the window harder than either predecessor: 9 of its 34 correct answers were
present only because the question named a time, against 6 of 38 tuned and 4 of 35 burned.

**Cost of deleting the window tier**, graded — not inferred. Every repeat was re-scored on the same
responses with every `window`-tier row deleted, by the same grader, with the same empty-result rule:

| set | full | window tier deleted | delta | units/q | questions lost |
| --- | --- | --- | --- | --- | --- |
| tuned | 95.0% | 80.0% | **−15.0** | 13.3 → 5.3 | E19 E20 E23 E24 E32 E35 |
| burned | 87.5% | 77.5% | **−10.0** | 11.4 → 8.2 | H03 H13 H27 H28 |
| clean | 85.0% | **62.5%** | **−22.5** | 12.4 → 5.4 | T02 T04 T05 T08 T11 T15 T21 T33 T39 |

Nothing was gained by the ablation on any set, and ±sd is 0.0% for all three ablations.

**Which method, stated:** computed from the tier labels, re-graded, not re-run with windows disabled.
`recallEpisodes` takes `{scope, question, limit}` and `/v1/recall` accepts `scope`, `question`, `limit`
only — there is no flag to disable the tier, and the instruction was not to restart the server. This
makes −22.5 an **upper bound on the accuracy of a windowless build, i.e. a lower bound on the cost**:
deleting rows from a response removes evidence and changes nothing else, whereas deleting the
mechanism would also remove the window *filter*, which is what currently stops a long out-of-window
document from outscoring the right sentence inside the window — the failure `recall.ts` documents at
its own ranking comment. A real windowless build would score at or below 62.5%.

Read together with the stratification, the window tier is carrying the clean set: without it the arm
scores 62.5%, which is 30.0 points below `full-context`.

## Every question `datum-recall` gets wrong on the clean set

Six of forty. Two are abstention traps, four are answerable. `note` is the server's, verbatim.

**T16** — trap, non-temporal, `forbid: 24 seconds | p99 | 250`. Verdict wrong (contaminated).
> `terms latency(7.295) time-to-first-token(7.295) jish(5.504) target(5.349) set(5.216) latency->latenci[stem](5.107); absent from corpus: p99`

*Diagnosis:* the server said the trap word out loud — `absent from corpus: p99` — and then returned 12
latency episodes anyway, one of which carried a forbidden number. The note contains exactly the
information needed to abstain and the arm has no mechanism that acts on it. `full-context` and `datum`
fail this one too; only `grep` passes it, by retrieving too little to be contaminated.

**T40** — trap, non-temporal, `forbid: 30s | 9am | every morning`. Verdict wrong (contaminated).
> `terms asked(6.602) jish(5.504) say(5.098) asked->ask[stem](4.621) time(4.251) table(4.16); absent from corpus: daily`

*Diagnosis:* same shape. `daily` is absent, the question presupposes a daily schedule that was never
set, and a status-table episode carrying a time-of-day survived into the context. Note the terms are
weak — `say`, `time`, `table` at idf 4–5 — which is the profile of a question with nothing rare to
match, and the arm's response to a weak match is still twelve rows.

**T18** — answerable, non-temporal, hard. `expect: van, truck`, missing `truck`.
> `terms pick(7.295) once(6.197) settled(5.909) instead(5.909) jish(5.504) names(5.216); absent from corpus: vehicles`

*Diagnosis:* out-ranked, not absent. Probed at greater depth the target ("we'll not serve the van,
we'll serve the truck") sits at rank 30, so it is unreachable at `limit=12` and reachable at 60. The
question paraphrases metaphorically ("two vehicles"), `vehicles` is absent from the corpus, and every
term that did match is a generic verb. No date, so no window to fall back on.

**T19** — answerable, non-temporal. `expect: vllm, sglang, modular, lmdeploy`, all four missing.
> `terms sent(5.909) four(5.686) jish(5.504) inference(5.349) projects(4.993) engines(4.897); absent from corpus: survey, refused, shortlist`

*Diagnosis:* out-ranked by one place. The target is at rank 13 with `limit=12`. Three of the question's
most distinctive words are absent from the corpus and what remains is common vocabulary, so the answer
ranks just outside a budget it would have made at 30.

**T30** — answerable, non-temporal. `expect: PR number, solution`, missing `PR number`.
> `terms told(7.295) report(5.909) instead(5.909) jish(5.504) care(5.504) part(4.81)`

*Diagnosis:* the only genuine vocabulary gap in the set, and the only failure that is not a ranking
problem. Probed to `limit=100` the answer never appears. The target is "I don't wanna know the PR
number, I wanna know what solution was taken" and the question is "which part of a status report he
did not care about" — no shared term at all, `absent from corpus` lists nothing because every question
term matched *something* irrelevant, and the question names no time, so there is no window to fall
back on. This is the failure mode `terms.ts` exists to attack and did not reach.

**T31** — answerable, **temporal**, the only failure where the window fired. `expect: artifact, text`,
missing `artifact`.
> `window 2026-08-21 "afternoon" read as 12:00-19:00 UTC; terms delivered(7.295) format(5.686) jish(5.504) delivered->deliv[stem](4.621) map(4.587) agent(3.489); absent from corpus: rejected, refuse, demand`

*Diagnosis:* `when.ts` read the time correctly — the target is at 14:31 UTC, inside 12:00–19:00 — and
the answer was still lost. Two rows in that window cleared the discriminating bar (`term+window: 2`),
which is enough to keep `recall.ts` out of pure-window mode, so the 12-row budget was ranked by a score
the target scores 0 on and the target fell to rank 19. This is the `when.ts`/ranking seam: a correct
window is not sufficient when the window contains weak term matches. Reachable at `limit=30`.

### The shape of the failures, measured

Probing each failure at increasing depth against the live server:

| question | reachable at limit | target rank |
| --- | --- | --- |
| T19 | 30 | 13 |
| T31 | 30 | 19 |
| T18 | 60 | 30 |
| T30 | never (probed to 100) | — |

So on the clean set, three of four answerable failures are ranking-depth failures and one is a true
vocabulary gap. The same probe on the burned set's five failures finds four of the five reachable by
depth alone — H24 at rank <30, H31 at 25, H10 at 64, H08 at 75 — which corrects the standing claim
that H31 is "a genuine vocabulary gap": at `limit=12` it is out-ranked, not absent. The fifth, H38, is
not depth-limited at all: its window (`2026-08-24 "morning" read as 05:00-13:00 UTC`) admits only 4
episodes at *any* limit, the source utterance is among them at rank 0, and the failure is the third of
its three required entries (`branches`) living outside what the window filter admits. Raising the
limit cannot reach it; that one is the window being too narrow for an answer that spans utterances.

Raising the limit is not free, and was measured rather than argued — `datum-recall` only, 3 repeats,
`--recall-limit=30`:

| set | limit 12 | limit 30 | traps 12 → 30 | trust 12 → 30 | tok/q 12 → 30 |
| --- | --- | --- | --- | --- | --- |
| tuned | 95.0% | 95.0% | 100% → 100% | 90.0% → 90.0% | 4,070 → 5,384 |
| burned | 87.5% | 92.5% | 100% → 100% | 75.0% → 85.0% | 7,064 → 9,665 |
| clean | 85.0% | **87.5%** | 50% → **25%** | 70.0% → 75.0% | 4,425 → 5,703 |

On the clean set depth buys T19 and T31 and loses the T22 trap: +2.5 accuracy, −25 points of trap
accuracy, 1.29× tokens. Even at 87.5% the arm is still 5.0 points below `full-context` and 15.0 points
short of the gate, so depth is not the missing 17.5 points.

## Reproduce

From `packages/datum`, with the live server on 8481:

```sh
export DATUM_BASE_URL=http://127.0.0.1:8481
export DATUM_TOKEN=$(cat /tmp/b3key.txt)

# the three primary runs — 4 arms x 3 repeats each
npx tsx bench/episodes/run.mts --questions=questions-third.json    --repeats=3 \
  --answerer=evidence --query=derived --out=results-third-derived.json
npx tsx bench/episodes/run.mts --questions=questions.json          --repeats=3 \
  --answerer=evidence --query=derived --out=results-tuned-derived-final.json
npx tsx bench/episodes/run.mts --questions=questions-heldout.json  --repeats=3 \
  --answerer=evidence --query=derived --out=results-heldout-derived-final.json

# the depth probe quoted in the last table
npx tsx bench/episodes/run.mts --questions=questions-third.json   --arms=datum-recall \
  --repeats=3 --recall-limit=30 --out=results-limit30-third.json
npx tsx bench/episodes/run.mts --questions=questions.json         --arms=datum-recall \
  --repeats=3 --recall-limit=30 --out=results-limit30-tuned.json
npx tsx bench/episodes/run.mts --questions=questions-heldout.json --arms=datum-recall \
  --repeats=3 --recall-limit=30 --out=results-limit30-heldout.json
```

The per-question target ranks (T18 rank 30, T19 13, T31 19, T30 unreachable, H31 25, H10 64, H08 75,
H38 4-row window) come from a `limit` sweep against the same endpoint, checking `expect` with
`grade.mjs`'s own §3 matcher so the reachability verdict uses the same rule as the benchmark:

```sh
for n in 12 30 60 100; do
  curl -sG http://127.0.0.1:8481/v1/recall -H "authorization: Bearer $DATUM_TOKEN" \
    --data-urlencode scope=org/aeonmind/proj/arc --data-urlencode limit=$n \
    --data-urlencode "question=$(jq -r '.[]|select(.id=="T31").question' bench/episodes/questions-third.json)" \
  | jq -r --arg n "$n" '"limit=\($n) n=\(.episodes|length) " + ([.episodes[]|.text]|to_entries|map(select(.value|test("ARTIFACT")))|map("rank=\(.key)")|join(","))'
done
```

Results files written by this run, none overwriting a prior one:
`results-third-derived.json`, `results-tuned-derived-final.json`,
`results-heldout-derived-final.json`, and `results-limit30-{third,tuned,heldout}.json`.
The pre-`when.ts` files `results-tuned-derived.json` and `results-heldout-derived.json` are untouched
and are the "before" column of the ladder table.

### What changed in the runner to produce this document

`run.mts` only; no file under `src/`, `migrations/` or any `questions*.json` was modified, and no
`grade.md` rule was changed — every verdict here comes from the existing grader in `evidence` mode.

- `--out=` overrides the output filename, so a re-measurement lands beside the earlier one instead of
  on top of it.
- `--reweight=` sets the composition every set's strata are re-weighted onto; default 16/40.
- A temporal classifier (three regexes over question text) and, per arm, `temporal_accuracy`,
  `non_temporal_accuracy`, both stddevs, `accuracy_reweighted`, and the lost ids in each stratum.
- Per row, `temporal`, and for `datum-recall` a graded `nowin_verdict` / `nowin_units`; per arm a
  `without_window` block carrying the ablation's accuracy, per-repeat values, stddev, delta, and the
  questions it loses.
- The `third` set gets its own label rather than falling through to the held-out string, and the
  held-out label now says it is burned.
