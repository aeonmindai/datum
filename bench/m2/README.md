# M2 — methodology

The stop gate from `HANDOFF.md` §16. Read `../../reports/m2-benchmark.md` for the result.

## What is being compared

Three arms, one model, identical questions, identical output contract ("answer with the value only;
if the record does not contain it, reply NOT ON RECORD; never guess").

| arm | what it sees |
|---|---|
| full-context | the corpus packed into ~150k tokens |
| file + grep | an agent that proposes `grep -E` patterns, runs them, then answers from the hits |
| datum | every live assertion in the store (~5k tokens), superseded and `dead` rows excluded by the store |

Two corpus conditions, because the first one flattered the baselines and the second is what the doc
actually specifies:

1. **curated** — the full-context arm is hand-fed `STATE.json`, `RETRACTED.md`, `DOCTRINE.md` and
   `FACTS.md`, i.e. the files the answers live in. A deliberately generous baseline.
2. **as it was** — 3,153 files / 63.7 MB including all 34 divergent `FACTS.md` copies, packed
   newest-first. A neutral rule that does not encode where answers live, under which `RETRACTED.md`
   falls out of context. This is the condition `HANDOFF.md` §16 describes.

## The question set

33 questions in three classes, every answer key verified to appear in its cited source file, and
every poison value verified to actually occur in the corpus (so the trap is real, not invented):

- **stale** (14) — the right answer requires honouring a supersession. The dead value is in the
  corpus, often many times over: `x5.53` appears 27 times, `27.2%` 15 times, `0.485` 11 times.
- **current** (15) — plain live values.
- **provenance** (4) — has this been reached, is it reproducible.

## Grading is mechanical, not an LLM judge

An independent audit found LOCOMO's judge accepted 62.81% of intentionally wrong answers, so nothing
here is graded by a model. Verdicts:

- `correct` — an expected value is present. A reply giving the live value *and* noting the retracted
  one is correct, not partial: that is the best possible answer.
- `poisoned` — a retracted value is present and the live one is not.
- `abstain` — no value, and the reply says it does not know.
- `wrong` — anything else.

Numbers compare **numerically, within 1%, on absolute value**, so `757.54` matches `757.5`, `$1.80`
matches `1.8`, and `-41%` matches `41`. String equality would penalise correct answers for
formatting, and that bias would run in Datum's favour. Boundaries are enforced so `60` does not
match `160`.

The grader is itself validated against 26 adversarial cases — correct, poisoned, mixed, abstaining,
empty, boundary-colliding and formatting-variant responses. It passes 26/26. If you change the
grader, re-run that validation first.

## Reproducing

The runner executed inside the build session's model harness rather than as a committed script, so
what is committed is the question set, the raw per-question responses for both conditions, and this
methodology. `questions.json` is the reusable artifact: point any three retrieval systems at it and
grade with the rules above.
