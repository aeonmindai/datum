# Episode retrieval, measured twice — and it still fails the gate

`packages/datum/bench/episodes/RESULTS.md` has the per-question detail. `SPEC.md` has the question
set construction. `HELDOUT.md` has the control set's provenance. This is the verdict.

## The number that counts

The retrieval half was rebuilt after reading the 14 questions it failed. That is tuning on the test,
so a second agent — which never read `src/` — built a **held-out set** of 40 questions: disjoint
source lines, identical kind and difficulty distributions, 4 traps.

**On the held-out set `datum-recall` scores 85.0%. The gate is +10 over both baselines. It is +47.5
over `grep` and −10.0 under `full-context`. It needs 105.0%. It fails by 20 points.**

| held-out set, derived queries | accuracy | wrong | tokens/q | ms/q |
|---|---|---|---|---|
| `full-context` | **95.0%** | 5.0% | 72,633 | 0 |
| `datum-recall` (new) | 85.0% | 15.0% | **7,817** | 21 |
| `datum` (old arm) | 75.0% | 25.0% | 12,477 | 23 |
| `grep` | 37.5% | 62.5% | 19,207 | 1,249 |

3 repeats, **0.0% standard deviation on every arm in both sets**. Nothing here is inside the noise.

## How much of the gain was real

Against the arm it replaces it is **+10.0 held-out**, at 37% fewer tokens. On the tuned set the same
comparison is **+30.0**. So **two thirds of the improvement did not survive a set the code was not
designed against.**

The overfitting signature is unambiguous and it does not flatter the rebuild:

| arm | tuned | held-out | delta |
|---|---|---|---|
| `grep` | 22.5% | 37.5% | **+15.0** |
| `datum` (old) | 62.5% | 75.0% | **+12.5** |
| `full-context` | 97.5% | 95.0% | −2.5 |
| `datum-recall` | 92.5% | 85.0% | **−7.5** |

The held-out set is *easier* for both untuned lexical arms and *harder* only for the tuned one.
Stratifying by whether a question names a date (the date reader fires on 30/40 tuned but 16/40
held-out) accounts for about 1.5 points of that; **roughly 6 points is a genuine generalisation
gap.**

## What the new mechanism is actually worth

Answers reached by tier, and the third tier is the one the rebuild was for — a question that names a
time whose words appear nowhere in what was said:

| tier | tuned | held-out |
|---|---|---|
| `term+window` | 19 | 9 |
| `term` | 5 | 16 |
| **`window` only** | **8** | **5** |

Deleting the window tier costs **22.5 points on the tuned set and 12.5 on the held-out set.** So it
is real, load-bearing, and worth about half what it first appeared to be. All 14 window-only answers
were audited: every one had a genuinely parsed window, none is a null-window artefact.

The date reader itself generalises cleanly — it fired on exactly the date-bearing questions in both
sets, **0 misses and 0 false fires.**

## Traps

`datum-recall` is the only arm that refuses all four on both sets.

| arm | tuned | held-out |
|---|---|---|
| `datum-recall` | **4/4** | **4/4** |
| `datum` | 4/4 | 4/4 |
| `full-context` | 3/4 | 2/4 |
| `grep` | 2/4 | 0/4 |

Context contamination on the held-out set is high for everything — `full-context` 82.5%, `datum`
60%, `datum-recall` 50%, `grep` 47.5%. Handing over a decoy in the retrieved context is not the same
as asserting it, but it is the thing an answerer would trip on, and every arm does it.

## The six it gets wrong, and why

Diagnosed individually by re-querying at limits 12, 40 and 100:

| | cause | fixable |
|---|---|---|
| **H08** | no stemmer: the question's rarest term is `login`, the corpus writes `logged in` | **yes, cheaply** |
| **H23** | `"Late on 14 Aug"` is read as the *whole day*, so the window is 4× too wide and the answer sits at rank 23 | **yes, cheaply** |
| **H10** | relative time — *"about half an hour later"* has no anchor this arm can see; answer found at rank 15, cut off by `limit=12` | partly |
| **H03** | question says `batch-1`, utterance says `b1`; no time named, so no window to fall back on | no |
| **H31** | question's whole content is the word `architectures`; the utterance names them and never uses it | no |

Two are one-line fixes. Two are a genuine vocabulary gap with no temporal handle, and no amount of
lexical work reaches them.

## Why this stops here

**I am not fixing H08 and H23.** They were found on the held-out set, and tuning against it would
destroy the only uncontaminated measurement in this report — which is exactly the mistake the first
round made and the reason a control set had to be built at all.

Doing it honestly needs a **third** question set, built by someone who has not read this file. That
is a real cost and it should be a decision, not a reflex.

## Honest limits

- **Token matching cannot see polarity.** *"He never said 90+ quality"* grades correct. Asserted in
  `verify.mts` so it cannot rot into a silent bug.
- **n = 40 per set.** Both sets were written inside this effort, by different agents; the held-out
  one was written without reading the code, which limits the conflict of interest rather than
  removing it.
- **The held-out builder disclosed its own selection pressure**: 6 of its 40 questions were swapped
  to reach the `only_in_transcript ≥ 8` floor. The criterion never moved; the questions did.
- **`datum-recall` has no oracle-topic upper bound** — it always receives the raw question, which is
  the point of it. Given oracle queries the *old* arm reaches 95.0% held-out, so 95% is the ceiling
  of this index either way and the rebuild closes most of the distance to it from below.
- **Four grading defects were fixed before any of these numbers were believed**, all of them found
  by re-deriving a value rather than by a test. They are itemised in §8 of `RESULTS.md`.
