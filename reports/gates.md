# The two gates, chased to the end

Both fail. This records why, with the numbers, so nobody has to chase them again from scratch.

The gate, verbatim from `HANDOFF.md` §14: *"If Datum cannot beat both full-context and
file-plus-grep by ≥10 points on our own data, it has no reason to exist."*

## Gate 1 — episode retrieval: FAIL by 17.5 points

Three question sets, built independently, pairwise disjoint. 3 repeats each, **0.0% standard
deviation in all twelve cells**, mechanical grading throughout.

| arm | clean (T) | burned (H) | tuned (E) | tokens/q |
|---|---|---|---|---|
| `full-context` | **92.5%** | 95.0% | 97.5% | 72,633 |
| `datum-recall` | 85.0% | 87.5% | 95.0% | **4,425** |
| `datum` (old) | 42.5% | 75.0% | 62.5% | 12,717 |
| `grep` | 22.5% | 37.5% | 22.5% | 19,048 |

The bar is `full-context + 10` = **102.5%**. `datum-recall` is **7.5 points below** it.

Two defences were tested and both died:

- **"The comparison is unfair"** — `full-context` is handed 2.4× more material, including the 8
  compaction summaries Datum refuses to store. **Answerability is identical**: 0 questions reachable
  from one corpus and not the other, in both directions, on both sets. And correcting the asymmetry
  makes `full-context` *better* — fed only Datum's 542 episodes it scores **100.0% / 97.5%**, because
  the summaries were contaminating it. The fair bar is higher, not lower.
- **"Full-context won't scale"** — the whole machine holds 1.94 GB of transcripts and only **312k
  tokens of human speech**, 0.058% of the bytes. It exceeds a 200k window at three projects and
  **never exceeds 1M**. It costs 40× more ($936 vs $23 per 1,000 questions) and remains possible.

## Gate 2 — M2 store-only: FAIL by 0.5 points, and it cannot be closed mechanically

Store-only scores 90.9% against a 94.4% bar. It failed on **coverage**, never on correctness — zero
wrong answers in 66 question-instances. Of the three facts it was missing:

| | recoverable from disk? | why |
|---|---|---|
| SGLang `page_size` = 256 | **yes** | three files carry `assert self.page_size == 256`; now ingested |
| `clone_in_cache` = +572 ms | **no** | measured, artifact discarded. `clone_in_cache` appears in zero structured files; only a prose conclusion survives |
| `b=1` is instruction-bound | **no** | a verdict about a mechanism, not a value in a field |

633 facts were added mechanically. Coverage moved by **at most 1 of 33 questions**, capping store-only
at 93.9%. **The gate cannot be reached without a human typing the answers in**, which would make the
number meaningless.

The loudest finding is not the coverage figure. The richest artifact class — 50 benchmark result JSONs
— is **unusable**: `summary.june_anchor_decode_tok_s = 640` is a *retracted* value hardcoded at
`arc-tools/quality/speed_probe.py:63`, so every future probe reproduces it, sitting beside two keys
that genuinely are measurements. `CEILINGS.json` and `STATE.json` carry four more. An automated
reader would have ingested poison as fact. It was correctly not built.

## What the chase actually established

**The tuning ladder is monotone: 95.0% → 87.5% → 85.0%.** Ten points of overfit across two sets, and
the clean score sits *below* the burned one.

**And the finding that matters more than either verdict**, stratified by whether a question names a
time:

| `datum-recall`, clean set | |
|---|---|
| questions naming a time | **96.7%** |
| questions not naming a time | **50.0%** |

Re-weighted onto the burned set's 16-of-40 temporal composition, the clean score falls from 85.0% to
**68.7%**. Composition was *hiding* the gap, not causing it — it accounts for 16.3 points of
concealment and none of the shortfall.

Deleting the window tier and re-grading the same responses drops the clean set to **62.5%**, and that
is an upper bound on a windowless build, because it removes the evidence without removing the window
*filter*.

**So this is a time-based index.** Given a date it is near-perfect. Without one it is a coin flip, and
no lexical work reaches that: the clean-set failures of that kind ask for "the four inference engines"
and "van and truck" against utterances that name them without ever using the abstraction.

## A methodology error of my own, recorded because it is the same shape as all the others

I committed the claim *"H03, H10 and H23 now retrieve"* with no regressions. Measured against the
**actual question strings**: H03 recovered, H23 recovered, **H10 never recovered** — its fold does not
appear in its plan at all — and **H24 regressed** from correct to wrong. Net **+1 question, +2.5
points**, against a claim of +3 and none lost.

The cause: I tested against my own paraphrase of the questions, written from their descriptions in
`RESULTS.md`, instead of the question text. My rewording was easier than the original. That is the
same failure as every other measurement bug in this project — a clean-looking number where the thing
measured was not the thing claimed.

Traps also regressed on a clean set: `datum-recall` 2/4, `full-context` 1/4, `grep` 2/4. The 4/4 that
held on the first two sets did not survive questions written by someone who had not seen the arm.

## The one move left, and it is a decision rather than a task

The non-temporal 50% is the whole remaining gap, and it is not reachable lexically. Closing it means
**semantic matching over episodes** — which is defensible here in a way it is not for facts: a
near-miss *number* is a lie, while a near-miss *quote*, dated and attributed, is a citation the reader
judges. That argument is already in `recall.ts`.

It costs an embedding model, and therefore either a local model in the image or an outbound host
carrying conversation text off the machine. That is a privacy and architecture decision, not an
optimisation, and it should not be started on the strength of a failed gate.
