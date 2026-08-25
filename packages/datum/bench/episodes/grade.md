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
2. It neither satisfies any `expect` entry nor trips `forbid` — tested with the **same** matchers
   scoring uses, so clause 2 inherits the §5 anchoring rather than running its own looser check.

Clause 2 is load-bearing. Without it, `I can't say for certain, but it was 84%` scores as a refusal
and the arm collects abstention credit for a confident wrong answer. With it, that string is an
answer and is graded as one.

It must reuse the scoring matchers and not a bare numeric scan, which is what it originally did. A
bare scan rejected `Not on record. Nearby the log reads: 84 explainer terms, 3 crash fixes, 85
unmeasured claims` as a smuggled answer on `E38`, because a list index happened to equal a forbidden
value — a correct refusal scored as a hallucination by the metric built to find hallucinations. Two
adversarial cases in §7 hold this in both directions.

## 5. The verdict

Per question, per arm, exactly one of `correct` / `wrong` / `abstained`.

**Answerable question** (`abstain` absent):

| response | verdict |
|---|---|
| `forbid` trips | `wrong` |
| `expect` satisfied, `forbid` clean | `correct` |
| is an abstention (§4), `llm` mode only | `abstained` |
| anything else | `wrong` |

The abstention row is **`llm` mode only**. In `evidence` mode the response is a retrieved context,
which can no more *be* a refusal than a trap's context can — and testing it for one produced
abstentions by accident of corpus vocabulary: the phrase `I don't know` is something Jish actually
says, so an arm returning irrelevant records containing it was credited with a refusal it never made.
Every such row had non-zero units. In `evidence` mode the only abstention is an **empty result**,
assigned by the runner when an arm returns nothing.

`forbid` is tested first and beats a satisfied `expect`. A response naming both the live number and a
superseded one has not answered the question, it has recited the file; and reciting the file is the
failure mode this whole product exists to attack. Every `forbid` entry in `questions.json` is a value
that a *correct* answer has no reason to state — verified by hand, question by question, and the two
places where that was arguable had the `forbid` removed rather than argued for.

### A bare number is not evidence of anything: anchored `forbid`

A `forbid` entry consisting **only of numeric tokens** does not trip on a bare match. It trips only
when the value occurs **within 12 tokens** of at least one of the question's `forbid_subject` tokens.
Entries containing a non-numeric token — `us-east`, `$44 per million` — are self-anchoring and are
matched by §3 unchanged.

This is a correction, and the thing it corrects is the exact failure this project exists to catch: a
clean-looking number that means something else. Measured over the 550-utterance corpus, the
unanchored rule fired on

- `44` in *"est bake **44** layers"* and *"PR 43 **44**"* — a layer count and a pull-request number,
  scored as an OpenRouter token price;
- `85` in *"**85** unmeasured claims"* and *"spent **85** on gpu"* — a numbered list item and a
  dollar figure, scored as an MTP acceptance rate;
- `48` in *"was at **48** gb"* — a memory reading, scored as an acceptance rate;
- `55` in *"54 scheduler coalescing **55** indexer loader"* — another list index, scored as a B200
  throughput figure.

Every one of those is a false positive, and between them they cost `datum` two of its four traps and
`grep` and `full-context` three each. A benchmark whose headline anti-hallucination metric fires on a
list index is measuring its own grader.

**Any trap carrying an all-numeric `forbid` entry must declare `forbid_subject`**, asserted by
`verify.mts`. The subject tokens are drawn from the *question's* subject, never from the answer:
`E37` anchors on `million|price|pricing|charge`, `E38` on `acceptance|mtp`, `E40` on
`b200|b300|aggregate`. `E39` needs none — `us-east` cannot float.

Twelve tokens is chosen as roughly a clause of English prose. It is wide enough to hold
*"`4eba13905`, 55 tok/s, +46% on B200"*, where the subject sits five tokens from the value, and narrow
enough to exclude the list-index cases above, where the nearest subject token is not in the sentence
at all. §7 carries the pair of adversarial cases that hold this line in both directions.

**Abstention trap** (`abstain: true`, `expect: []`). The rule differs by answerer mode, because the
two modes grade two different things:

| mode | `correct` | `wrong` |
|---|---|---|
| `llm` | the response is an abstention (§4) | anything else |
| `evidence` | no `forbid` entry appears in the retrieved context | a `forbid` entry appears |

In `llm` mode a system has asserted something and the trap is won by refusing. In `evidence` mode
the response is a pile of retrieved records, which can never *be* a refusal — so grading traps by
looking for one makes all four unwinnable for every arm, which would be a fact about the grader and
not about any system. The first run of this benchmark did exactly that and reported `traps 0.0%`
across all three arms. In evidence mode a trap is therefore won by **not surfacing the tempting
value**, which is the thing actually being measured: whether the arm puts a number in front of an
agent that the human never said.

An empty `expect` is vacuously satisfied, so traps never fall through to the answerable table.
Answering a trap is `wrong`, never `abstained`: the system asserted something about a question the
record does not answer, which is the definition of a hallucination.

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
- a **forbidden value that is not its subject** — `85 unmeasured claims, 3 crash fixes` on `E38`,
  where `85` is a list index. Must **not** contaminate, and the trap must score `correct`;
- the same forbidden value **attached to its subject** — `the acceptance rate came back at 85%` on
  `E38`. Must contaminate, and the trap must score `wrong`. The pair is what proves the ±12-token
  anchor works in both directions rather than merely being lenient;
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
  `{ ok: true, episodes: [...] }` where each episode carries `matched` in
  `phrase | fts | trigram | filter`. Endpoint, scope and token come from `DATUM_BASE_URL`,
  `DATUM_EPISODES_PATH`, `DATUM_SCOPE` and `DATUM_TOKEN`, so a differing route costs one environment
  variable and no code change. The `matched` tier is recorded and reported per arm-run: an answer
  reached only by trigram is a fuzzy hit and is worth knowing about separately.

  **One request per query term, unioned.** The arm issues the query terms *individually* and unions
  the episodes, capped at `limit`. This is not a detail — the first run of this benchmark sent all
  four terms as one `q`, which the endpoint resolves as a single FTS query requiring every term,
  while `grep` got four independent searches unioned. Datum returned nothing on 28 of 40 questions
  and scored 15.0%; the number measured a query-shape mismatch and nothing else. Equalising the
  semantics is what makes the comparison mean anything, and it raised datum's score, which is
  precisely why it is written down here rather than left in a commit message.

### The two query regimes

Both are mechanical, both are applied identically to all three arms, and which one produced a number
must appear beside it. `results.json` records `query_regime` and a note explaining it.

- **`derived`** (default, the headline). Content terms taken from the **question** text: stopwords
  and sub-4-character tokens dropped, digits-initial tokens dropped, deduplicated, sorted by
  ascending document frequency over the 550-utterance corpus, first four kept. Rarest-first because a
  term in two utterances locates a conversation and a term in two hundred does not.

  This regime is hard, and it is hard for an honest reason: the questions **deliberately paraphrase**
  the corpus. A question that reuses the corpus's own words leaks its answer into the query and
  measures nothing. The consequence is that both lexical arms are working against a vocabulary gap,
  and that gap is a real property of the problem — the person asking "what did I decide about the
  bit width" does not remember that they typed "why 2.25 bits".

- **`topic`** (`--query=topic`), an **oracle-topic upper bound** and labelled as one everywhere it
  appears. Terms are the rarest content terms of the ground-truth utterance with every token
  occurring in an `expect` or `forbid` entry removed. It models the person who remembers roughly what
  the conversation was about but not the value, which is the person this product is for. It never
  contains the answer.

  It is an upper bound and not a result, because it is built from the answer's own record: it
  guarantees the target utterance contains the query terms, reducing the task to ranking one record
  out of 542. Report it next to `derived`, never instead of it.

  Two questions are **unanswerable by construction** in this regime and it must be said rather than
  smoothed: `E14` ("Ban greedy forever") and `E33` ("Three agents died.") are so short that removing
  their answer tokens leaves no term of four characters or more, so the query is empty and every
  retrieval arm abstains. That is an artifact of the regime, not a property of any arm, and it caps
  `topic` at 38/40 for `grep` and `datum` alike.

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

## 10. The fourth arm, and the second question set

Appended before the run that produced `RESULTS.md`, so that the rules exist before the numbers do.
**No grading rule in §2–§7 changed.** The grader binary is untouched, `evidence` mode is untouched,
`forbid` handling is untouched, and every score in `RESULTS.md` — old arms and new — comes out of the
same `grade.mts`. Nothing in this section moved a previously published number. What it adds is a
fourth arm, a second set, and two derived statistics.

### 10.1 `datum-recall`

- **`datum-recall`** — `GET /v1/recall?scope=&question=&limit=` with a bearer token, expecting
  `{ ok: true, note, plan, episodes: [...] }` where each episode carries `tier` in
  `term+window | term | window`, a `score`, and `matched_terms`. Endpoint, scope and token come from
  `DATUM_BASE_URL`, `DATUM_RECALL_PATH`, `DATUM_SCOPE` and `DATUM_TOKEN`, exactly as the `datum` arm
  takes `DATUM_EPISODES_PATH`. Default `limit` is 12, `--recall-limit=`.

  **The entire question text is sent verbatim, in every regime.** This arm performs no term
  extraction: it does not use `queryTerms`, it does not use `STOP`, and `--query=topic` does not
  change what it sends. That is not an exemption from the shared query rule, it is the hypothesis
  being tested — that interpreting the question is the server's job. It cuts both ways and the cost
  side has to be stated: this arm never gets the oracle-topic query, so in the `topic` regime the
  other three arms are handed ground-truth-derived terms and `datum-recall` is not. Its `topic`
  column is therefore *not* an upper bound and must not be read as one; it is the same `derived`
  behaviour reported beside a stronger baseline.

  **`datum` is unchanged and stays in the table.** It keeps deriving four terms and issuing one
  request each, unioned, exactly as §8 specifies. It is the before-picture and it is not permitted
  to improve.

- **Tier attribution.** Two derived counts, both computed with the §3 matcher and no new rule:
  - `answer_tiers` — for each answerable question whose retrieved context satisfies `expect`, the
    context is rebuilt from **one tier at a time** and attributed to the first tier, in the order
    `term+window`, `term`, `window`, that satisfies `expect` on its own; `combined` if no single tier
    does.
  - `window_only` — that question's context is rebuilt with **every `window`-tier episode removed**,
    and the count increments when `expect` is then no longer satisfied. This is the honest reading of
    "found only because the question named a time", and it is the number to quote. `answer_tiers`
    over-credits `window` whenever a term-tier episode also carried the answer, so where the two
    disagree, `window_only` is smaller and `window_only` is correct.

  Attribution is computed for answerable questions only. On an abstention trap there is no `expect`
  to locate, and a trap is scored by §5 like every other question in every other arm.

### 10.2 Two question sets

`--questions=<path>`, default `questions.json`. Same runner, same grader, same arms; the set name is
carried in `question_set` and in the output filename, which is `results-<set>-<regime>.json`.

- **`questions.json` (`tuned`, `E01`–`E40`).** §9 governs it. The retrieval code now under test —
  including `/v1/recall`'s date reading and df weighting — **was designed after reading which of
  these questions the previous build failed.** Every number on this set is contaminated by that and
  is required to be labelled `tuned` wherever it appears. It is reported because the before-picture
  needs a fixed set, not because it measures generalisation.
- **`questions-heldout.json` (`heldout`, `H01`–`H40`).** Built by an agent with no access to the
  retrieval code, from source lines provably disjoint from the `E` set, with §9's distribution and
  trap structure reproduced. Its construction and its own self-criticism are in `HELDOUT.md`.
  **This is the set the gate is decided on.** Where the two disagree, the held-out number is the
  result and the gap is the overfit.

`verify.mts` asserts §9 against `questions.json`. It has not been pointed at the held-out file; the
equivalent assertions for that set were run by its author and are transcribed in `HELDOUT.md` §1–§6.
That is a weaker guarantee than a checked-in test and is recorded as such.

### 10.3 The gate

`datum-recall` passes only by beating **both** `grep` and `full-context` by at least 10 accuracy
points on the **held-out** set in the `derived` regime, under `evidence` answering. Beating one
baseline is not a pass. Beating them on the tuned set is not a pass. A margin inside one repeat
standard deviation is reported with that standard deviation next to it.
