# Episode retrieval vs grep vs full context — grading definition

This file defines grading completely and is written to be implemented without asking the author a
question. It was written before any answer was scored. Where a choice could go two ways the choice
is stated together with its reason, because the reason is what stops the next reader from "fixing"
it.

The claim this instrument exists to test, from `START_HERE.md`: *a plain text file plus `grep` scores
74.0% on LOCOMO where Mem0's graph variant scores 68.5%; if Datum cannot beat both full-context and
file-plus-grep by ≥10 points on real data, it should not exist.* An instrument that cannot return
that verdict is worthless, so every rule below is chosen to let the honest baselines win if they
deserve to.

There is **no LLM judge anywhere**. Grading is a pure function of two strings and a question record.

---

## 1. The corpus, and what counts as evidence

`corpus.mts` is the single definition. Six real Claude Code transcripts, 668 MB, `.jsonl`, one
record per line. Filtering to records the human actually typed leaves **550 utterances /
253,912 bytes**; adding the 49 bare `[Request interrupted…]` markers gives the 599 figure the corpus
is usually described by. Exclusions and their measured counts are documented at
`readHumanUtterances`.

Every answerable question is answerable **from the human utterances alone**. This is asserted
mechanically by `verify.mts`, not asserted by the author: for each question, every `expect` entry
must match somewhere in the 550-utterance corpus. The reason is fairness between arms — the
full-context arm is handed exactly those 550 utterances, so a question needing assistant prose would
be unanswerable by construction for one arm and the comparison would be rigged.

The `grep` arm searches the **raw `.jsonl`**, so it sees assistant text, tool calls and everything
else. It reads a strict superset of what the other arms read. That asymmetry is deliberate and it
favours the baseline. A benchmark that starves its baseline proves nothing.

Eight of the 8 `/compact` continuation summaries are user-role records containing model-written
prose, and they hold 151,752 of the 253,912 bytes. They stay in the corpus, because a retrieval
system meets them in production. No question sources a claim from one, and a question of the form
"what did the human say" is verified absent over the whole set *including* them, which is the
stricter direction.

## 2. Normalising a string

`norm(s)`, applied to both a response and every `expect`/`forbid` entry:

1. Unicode NFKC.
2. Lowercase.
3. Typographic punctuation folded to ASCII: `’‘` → `'`, `”“` → `"`, `–—` → `-`, `×` → `x`.
4. Currency symbols `$ £ €` deleted.
5. Thousands separators inside digit runs deleted, repeatedly: `9,000` → `9000`.
6. `k` / `K` suffix on a bare number expanded: `14k` → `14000`. This exists because the corpus
   contains `I NEED 14K AGGREGATE` and a correct answer may legitimately write `14,000`.
7. Number-word to digit for `zero`…`twelve`. One direction only, words to digits.
8. Units folded to a canonical word and split off the number, so `30s` and `30 seconds` become the
   same two tokens:
   `s|sec|secs|second|seconds` → `second`; `ms|millisecond|milliseconds` → `ms`;
   `min|mins|minute|minutes` → `minute`; `h|hr|hrs|hour|hours` → `hour`;
   `gb|gib|gigabyte|gigabytes` → `gb`; `tok/s|tokens/s|tok/sec|t/s|tps` → `tok/s`;
   `%|pct|percent` → `%`.
9. A multiplier glued to its number split off: `25x` → `25 x`. `8x8` is untouched.
10. Whitespace collapsed to single spaces, trimmed.

## 3. Tokenising, and what counts as a hit

`tokens(s)` = `norm(s)` split on every character outside `[a-z0-9./%=]`, then `.`, `/` and `=`
trimmed from each end, empty tokens dropped. `.`, `/` and `=` survive *inside* a token because they
are load-bearing there — `13.26`, `tok/s`, `v=4`, `qtip2b` — and trimming the ends means a
sentence-final `640.` is still the number 640.

`-` and `+` are **separators, not token characters**. The corpus writes `the competition issues
10–30` and `90+ QUALITY`, and a numeric entry has to be able to reach the `10`, the `30` and the
`90` inside those. Treating a hyphen as part of a token is how `10–30` becomes an opaque blob that
no numeric expect can match, and the question silently becomes unanswerable.

A token is **numeric** when it matches `^-?\d+(\.\d+)?$`. Numeric tokens are compared **by value**
after trailing-zero trimming, so `757.5` matches `757.50` and — the point of doing it this way —
`28` does **not** match `280`. Substring matching on numbers is the single most common way a grader
of this kind silently passes wrong answers, and §7 has an adversarial case for exactly it.

A non-numeric response token satisfies a non-numeric expect token when the response token
**starts with** it. So `approve` is satisfied by `approved`, `approves` and `approval`, and `second`
by `seconds`. One direction only: a shorter response token never satisfies a longer expect token.
This buys cheap morphology with no stemmer and no dictionary. It is the one deliberately generous
rule in the file, and §7 exists to prove it is not generous enough to pass a wrong answer.

An `expect` **entry** hits when `tokens(entry)` occurs as a **contiguous subsequence** of
`tokens(response)` under those two comparisons. Contiguity is what makes a multi-word entry such as
`prefix cache` or `1 second` mean the phrase and not two words that happen to both appear; combined
with numeric-by-value it is also what stops `1 second` matching `21 seconds`.

`expect` is **satisfied** only when **every** entry hits. All, never any.

`forbid` **trips** when any entry hits.

## 4. Abstention, detected and not guessed

A response is an **abstention** when both hold:

1. `norm(response)` matches
   `\b(not on record|no record|not recorded|nothing on record|not stated|never stated|no evidence|
   not in the (transcript|corpus|record|episodes)|insufficient (evidence|information)|
   (can not|cannot|can't|unable to) (say|tell|determine|answer|find)|(do not|don't|dont) know|abstain)\b`
2. It contains **no** numeric token that appears in any `expect` or `forbid` entry of the question.

Clause 2 is load-bearing. Without it, `I can't say for certain, but it was 84%` scores as a refusal
and the arm collects abstention credit for a confident wrong answer. With it, that string is an
answer and is graded as one.

## 5. The verdict

Per question, per arm, exactly one of `correct` / `wrong` / `abstained`.

**Answerable question** (`abstain` absent):

| response | verdict |
|---|---|
| `forbid` trips | `wrong` |
| `expect` satisfied, `forbid` clean | `correct` |
| is an abstention (§4) | `abstained` |
| anything else | `wrong` |

`forbid` is tested first and beats a satisfied `expect`. A response naming both the live number and a
superseded one has not answered the question, it has recited the file; and reciting the file is the
failure mode this whole product exists to attack. Every `forbid` entry in `questions.json` is a value
that a *correct* answer has no reason to state — verified by hand, question by question, and the two
places where that was arguable had the `forbid` removed rather than argued for.

**Abstention trap** (`abstain: true`, `expect: []`):

| response | verdict |
|---|---|
| is an abstention (§4) | `correct` |
| anything else | `wrong` |

An empty `expect` is vacuously satisfied, so traps are graded on §4 and `forbid` alone and never fall
through to the answerable table. Answering a trap is `wrong`, never `abstained`: the system asserted
something about a question the record does not answer, which is the definition of a hallucination.

**`wrong` versus `abstained`.** `wrong` means content was asserted and the assertion fails. `abstained`
means no content was asserted. They are never the same number, they are never summed, and neither is
reported without the other.

## 6. Scores

Let `C`, `W`, `A` be the counts over the 40 questions, `C + W + A = 40`.

```
accuracy       = C / 40
error_rate     = W / 40
abstain_rate   = A / 40
trust          = (C - W) / 40
over_abstain   = |{ q : not q.abstain and verdict = abstained }| / 36
trap_accuracy  = |{ q : q.abstain and verdict = correct }| / 4
```

`accuracy` is the headline and is the number the ≥10-point gate is read from. `trust` is the number
that decides whether a thing is usable: it prices a confident wrong answer at exactly the cost of
losing a right one, so a system cannot buy accuracy with guesses. Report every one of them; a report
carrying `accuracy` alone has hidden the trade rather than measured it.

Also report `accuracy` broken down by `kind` and by `difficulty`. An arm that scores well only on
`easy` has not solved the problem the four measured gaps describe.

**Aggregation across repeats.** `--repeats=N` re-runs every arm end to end. Report, per arm, the
mean and the **sample standard deviation** of `accuracy` across repeats, and the count of questions
whose verdict was not identical in every repeat (`unstable`). A single run with no variance estimate
is not a measurement. `grep` and the evidence answerer are deterministic, so their expected
`stddev` is 0 and their `unstable` count is 0 — and if it is not, something is wrong with the run
and the number must not be reported as a score.

## 7. Adversarially validating the grader

The grader is code and code is wrong until it has been attacked. Before any arm is scored,
`verify.mts` runs a fixed adversarial suite of hand-written responses that a lenient grader would
pass, and asserts each one is **not** graded `correct`. The suite covers, at minimum:

- a plausible-but-wrong number (`the target was 250 tok/s` where the answer is 640);
- a **near-miss number** that a substring grader passes (`$280` where the answer is `$28`;
  `21 seconds` where the answer is `1 second`);
- a **superseded** number, live at a different date (`96%` where the answer at that date was `84%`);
- the right number attached to the wrong subject (`GEMV reached 90%` where he said 50%);
- a confidently-worded non-answer (`The record is unambiguous on this point.`);
- a **hedged wrong answer** (`I can't be certain, but it was 84%`) — must not score as an
  abstention;
- a response that answers a **trap** confidently;
- a response naming the superseded and the live value together (`he moved from 84% to 96%`);
- the **question restated** as the answer;
- an empty string and a whitespace-only string;
- a partial answer missing one of several required entries;
- the right tokens in a **negated** sentence (`he never said 640`) — this one is expected to pass
  §3 and is included precisely so the limit is on the record rather than hidden: token matching
  cannot see polarity, and a system that games the benchmark by negating everything would be caught
  by nothing here. It is asserted as a **known limitation**, not as a pass.

`verify.mts` prints the suite size and the number rejected. Any suite member that scores `correct`,
other than the negation case which is asserted separately as a known limitation, fails the build.

## 8. What each arm may do

All three arms answer the same 40 questions with the same grader.

- **`grep`** — `grep -F -i -n -a` over the raw `.jsonl` for a query derived from the question,
  first `N` matching lines in file order as the context. Fixed-string and case-insensitive because
  that is what an engineer types. `-a` because the transcripts contain bytes grep would otherwise
  call binary and skip in silence, which would hand the baseline a loss it did not earn. The query is
  derived from the question text by a rule fixed in `run.mts` and identical for all 40 questions —
  no query is hand-tuned to a question, because hand-tuning the baseline's query is how a baseline
  gets quietly rigged.
- **`full-context`** — all 550 human utterances, in transcript order, handed over whole. Its input
  token count is measured and reported per question; the cost is part of the result, not a footnote.
- **`datum`** — `GET /v1/episodes?scope=&q=&limit=` with a bearer token, expecting
  `{ ok: true, episodes: [...] }`. Endpoint and token come from `DATUM_BASE_URL`,
  `DATUM_EPISODES_PATH` and `DATUM_TOKEN`, so a differing route costs one environment variable and
  no code change.

**The answerer.** Grading needs an answer string. Two modes, and which one produced a number must
appear next to it:

- **`evidence`** (default, deterministic, no network). The retrieved context *is* the response. The
  verdict then measures **retrieval sufficiency** — did the arm put the answer in front of the
  agent. This is the arm's accuracy **ceiling**: a faithful reader cannot answer from evidence it
  was never shown. It is deterministic, it costs nothing, and it can fail, which is what makes it
  worth reporting as the default.
  In this mode `forbid` is **not** applied to answerable questions and is reported separately as
  `contamination`, because nobody has asserted anything yet — surfacing a stale value alongside the
  live one is a different sin from stating it. `forbid` **is** applied to abstention traps, where
  surfacing the tempting value is the entire failure being measured.
- **`llm`** (opt-in, `BENCH_ANSWERER_URL` + `BENCH_ANSWERER_MODEL`). One fixed model, one fixed
  prompt, temperature 0, same for every arm; only the context differs. Its output string is graded
  under §5 with `forbid` fully live. The model is an **answerer**, never a judge: it never sees
  `expect`, `forbid` or any part of `questions.json` other than the question text.

Mixing the two in one table is prohibited. `results.json` records `answerer` per run and the printed
table names it in the header.

## 9. Construction rules the question set must obey

Asserted mechanically by `verify.mts`, which fails the build rather than warning:

1. 40 questions, ids `E01`…`E40`, unique.
2. Every `source.quote` is a **verbatim substring** of the utterance at `source.file`:`source.line`.
   Truncation is the only permitted edit — a quote may be a prefix, suffix or interior run of the
   utterance, so that a credential appearing in the transcript can be left out of a public repo. Two
   quotes are truncated for exactly that reason.
3. `source.ts` equals the record's `timestamp`, and `source.session` its `sessionId` prefix.
4. Every `expect` entry of every answerable question hits somewhere in the 550-utterance corpus (§1).
5. Every `expect` entry hits the **whole source utterance** at `source.line`, **or** the question is
   marked `spans_utterances: true` and names every other utterance it needs in `source.also`. The
   test is against the utterance and not against the ≤200-char `quote`, because a single utterance
   here runs to 500 characters — the 17 Aug five-point ultimatum names `FA2` in item 1 and the three
   GPU architectures in item 5 — and a quote short enough to read is not always long enough to carry
   every entry. The quote is the load-bearing excerpt; the utterance is the evidence.
6. No `forbid` entry hits its own source utterance. A forbidden value present in the very record the
   answer is drawn from is a broken question, not a hard one.
7. Exactly 4 questions have `abstain: true`, each with `expect: []`, and each verified to have **no**
   answering utterance: a fixed probe list per trap, every probe matching zero of the 550.
8. ≥8 questions have `source.only_in_transcript: true`, meaning **no single tracked file** in the
   Arc repo at the pinned commit contains all of that question's `expect` entries, and
   `git log -S` on the question's most distinctive entry returns no commit. The test is the
   conjunction over one file, not the presence of individual tokens, because a fact is recoverable
   from a committed file only if that file holds the whole fact.

Rule 8's commit is pinned in `results.json`. `memory/` **is** tracked in the Arc repo and
`memory/mission/SESSION7_RECONSTRUCTION.md` deliberately transcribes parts of the conversation, so a
good number of otherwise attractive questions are **not** `only_in_transcript` and are labelled
`false`. That was measured, not assumed, and the labels were corrected in that direction.
