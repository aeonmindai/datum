# Episode retrieval benchmark — specification and result

This is the instrument that decides whether episode retrieval is worth shipping. It is built to be
capable of failing, and on the headline regime **it fails the gate**. That verdict is in §6.

Four files carry the instrument, one carries the result:

| file | what it is |
|---|---|
| `corpus.mts` | the single definition of "a thing the human said"; streams 668 MB, never loads a file whole |
| `questions.json` | 40 questions, every one pinned to a verified source line and a verbatim quote |
| `grade.md` | the grading rules, written before anything was scored. **The authority.** |
| `grade.mts` | a faithful implementation of `grade.md`. No model, anywhere. |
| `verify.mts` | asserts every construction rule, then attacks the grader with wrong answers |
| `run.mts` | three arms, two query regimes, variance across repeats |
| `results.json` / `results-topic.json` | the numbers, one file per query regime |

```
npx tsx bench/episodes/verify.mts                      # must pass before any number is believed
DATUM_TOKEN=$(cat /tmp/benchkey.txt) \
  npx tsx bench/episodes/run.mts --repeats=3            # headline: derived-query regime
DATUM_TOKEN=... npx tsx bench/episodes/run.mts --repeats=3 --query=topic   # oracle upper bound
```

---

## 1. What is being measured, and against what

The four gaps this is aimed at: a thing said in chat is lost; the reason a line of code exists lived
in a conversation; nobody knows where yesterday ended; no agent knows what the other agents are
doing. All four reduce to one testable question — **can a system put the sentence a human actually
said back in front of an agent that needs it?**

The bar is set in `START_HERE.md` and it is not mine to soften: a plain file plus `grep` scores 74.0%
on LOCOMO where Mem0's graph variant scores 68.5%, and *if Datum cannot beat both full-context and
file-plus-grep by ≥10 points on real data, it should not exist.*

So three arms, same 40 questions, same grader:

- **`grep`** — `grep -F -i -n -a` over the raw `.jsonl`. The honest baseline, and a strong one. It
  searches a **strict superset** of what the other arms see, because a raw JSONL line is a whole
  record and includes assistant text, tool calls and everything else. A benchmark that starves its
  baseline proves nothing.
- **`full-context`** — all 550 human utterances handed over whole, every question. 72,633 input
  tokens per question. The cost is part of the result.
- **`datum`** — `GET /v1/episodes?scope=&q=&limit=` over HTTP with a bearer token. Nothing in this
  directory imports from `src/`; the arm is a client like any other, so a route change costs an
  environment variable.

## 2. The corpus

Six real Claude Code transcripts for the Arc project, 668 MB, largest single file 82 MB, 37,085
records, 14 days from 2026-08-10 to 2026-08-24.

Filtering to records the human typed leaves **550 utterances / 253,912 characters / 263,554 bytes**.
Adding the 49 bare `[Request interrupted…]` markers gives **599 human records**. Exclusions, each
measured rather than assumed: 290 `isMeta`, 3,479 `tool_result` blocks, 741 `<task-notification>`
blocks (2.4 MB — ten times the size of everything the human actually said), 56 slash-command echoes.

**Datum stores 542 of the 550.** The ingest path drops the 8 `isCompactSummary` records, which hold
151,752 of the 253,912 characters. They are dropped because a compaction summary is a document that
has *already* discarded its qualifiers, and storing 15–21k characters of it as testimony from a named
human would outrank every real sentence in the corpus by sheer length.

**That exclusion costs datum nothing on this question set, and it was checked rather than assumed.**
`verify.mts` asserts, every run, that every `expect` entry of all 40 questions matches inside the
542-episode set, and that no question sources a claim from a summary. The result printed each run is:

> `compaction-summary dependency: NONE — every answer survives the ingest exclusion, so datum loses
> no question to it`

Had any question depended on a summary it would have **stayed in the set** and been reported as a
real loss for datum. A benchmark that deletes the cases its subject fails measures nothing.

## 3. The question set

40 questions. Every one carries `source.file`, `source.line`, `source.session`, `source.ts` and a
verbatim `quote`; `verify.mts` re-reads the exact line off disk and asserts the quote is a substring
of it, that the timestamp and session match the record, and that the record is not a compaction
summary. **42 quotes checked (40 primary plus 2 secondary on the two multi-utterance questions), 0
failed, 0 discarded.** Two quotes are truncated to exclude a Hugging Face token that appears in the
transcript, which is the only permitted edit.

**Discards, in full.** No quote failed the verbatim check — every question was drafted by reading its
source line directly, so nothing was lost at that gate. Seven candidates were discarded elsewhere and
it is worth saying where, because the reasons are the instrument working:

- **1 failed a construction rule.** "Have I ever approved fucking PRs?" was drafted with
  `expect: ["approve", "never"]`, and rule 5 rejects it — the utterance says *ever*, not *never*, so
  the entry is not present in its own evidence. It is a question about a fact the grader could not
  check, and it was cut rather than loosened.
- **4 were cut to make room for the traps.** The GEMV 50/90/60 ms correction, the standalone TTFT-24
  rejection, the 80–600 throughput gap and the exclusion of driver work. All four are real and
  verified; the set only has 40 slots and 4 belong to the traps.
- **2 were replaced after the `only_in_transcript` computation contradicted the label I had written.**
  The CPU-word ban (`expect: ["cpu"]`) and the `$28` jab (`expect: ["28"]`) were both single generic
  tokens: recoverable from a committed file, and weak grading targets besides — an answer containing
  `cpu` anywhere would have passed. They became E24 (`2.25 bits`) and E35 (the batch-256 /
  2000-word-essay scenario), which are distinctive and which the machine confirms are transcript-only.

| distribution | |
|---|---|
| kind | `correction` 8, `target-change` 8, `decision` 6, `abandoned` 5, `preference` 5, `who-said` 4, `when` 4 |
| difficulty | easy 7, medium 26, hard 7 |
| `only_in_transcript` | 8 |
| abstention traps | 4 |

The bias is where the assignment asked for it: 8 corrections, 8 target changes, 5 abandonments and 4
attributions — 25 of 40 — because those are the classes that actually cost time. Real examples in the
set: `you said 600 tok/s how is now that 40?` (E01), `84% and essentially settled??? you promised me
90+` (E02), `H200 is 141gb nigga` correcting the agent's use of the A100's 80 GB (E03), and
`make it permute at load nigga.` overruling his own question of nineteen hours earlier (E13).

**`only_in_transcript` is computed, never authored.** A question earns it when **no single tracked
file** in the Arc repo at `526c909986de48b13d4ae33964baf0451fb79270` contains all of its `expect`
entries, and `git log -S` on its rarest entry returns no commit. The conjunction over one file is the
right test, because a fact is recoverable from a committed file only if that file holds the whole
fact. 1,746 of 1,825 tracked files are scanned each run and the recorded label must equal the
computed one or the build fails.

This turned out to matter a great deal. `memory/` **is** tracked in the Arc repo and
`memory/mission/SESSION7_RECONSTRUCTION.md` deliberately transcribes parts of the conversation, so my
first labelling was wrong in the flattering direction — I guessed ten and the machine found **one**.
Getting to eight required making the expect sets carry the distinctive part of each fact, and two
questions were replaced outright. The eight that stand are E16, E22, E23, E24, E27, E31, E32, E35.

**The four traps** are questions the record genuinely does not answer, phrased so a topic-matcher will
happily answer them anyway. Each carries `absent_probes`, and `verify.mts` asserts every probe matches
zero of the 550 utterances:

- **E37** — the price per million tokens for selling on OpenRouter. OpenRouter is discussed
  constantly; Jish never names a price. The assistant does: `$44`, `$43.96` and `$12.06 per million
  tokens` all appear in the transcripts, and they are the `forbid` set.
- **E38** — the MTP acceptance rate Arc had to hit. Jish *asks* `And what is the MTP acceptance
  rate?` and never states a requirement. `85%–90%` and `48` appear elsewhere in the transcripts.
- **E39** — the cloud region for the rented boxes. `us-east` appears only as a CLI flag example and
  in an S3 region list.
- **E40** — an aggregate figure committed to on B200/B300. Both are discussed; no number is his.

Each trap's `forbid` set is therefore a real value a lexical system will surface if it pattern-matches
the topic — which is what the trap measures.

## 4. Grading

Defined completely in `grade.md`, written before scoring, implemented in `grade.mts`, with no LLM
judge anywhere. The parts that decide outcomes:

- numbers compared **by value**, so `757.5` matches `757.50` and `28` does **not** match `280`;
- `-` and `+` are separators, so a numeric entry can reach the `10` and `30` inside `10–30` and the
  `90` inside `90+`;
- units folded number-adjacently, so `1s`, `1 sec` and `1 second` are one thing;
- a multi-word entry must appear as a **contiguous** token run, which is what stops `1 second`
  matching `21 seconds`;
- a non-numeric response token satisfies an entry token when it **starts with** it, so `approved`
  satisfies `approve` — the one deliberately generous rule, and the reason §7 of `grade.md` exists;
- an **all-numeric `forbid` entry is anchored**: it trips only with a `forbid_subject` token within
  12 tokens. §4.1 below is why.

**Adversarial validation: 23 hand-written wrong answers, 23 rejected.** The suite covers
plausible-but-wrong numbers, the two near-misses a substring grader passes (`$280` for `$28`, `21
seconds` for `1 second`), a superseded value live at a different date (`96%` where the answer is
`84%`), the right number on the wrong subject, a confidently-worded non-answer, a hedged wrong answer
that must **not** read as an abstention (`I can't be certain, but it was 84%`), two traps answered
confidently, live-and-superseded stated together, the question restated as its own answer, empty and
whitespace-only strings, two partial answers, an order-of-magnitude slip, a swapped unit, and the
three anchoring cases from §4.1.

Alongside them, **8 positive controls** — genuinely correct answers that must be accepted, because a
grader that rejects everything passes an adversarial suite trivially. 8 of 8 accepted.

One case is recorded as a **known limitation rather than a pass**: token matching cannot see polarity,
so `He never said 90+ quality, 640 tok/s or that the model fits.` grades `correct`. `verify.mts`
asserts that it still reproduces, so the limitation cannot rot into a silent bug.

### 4.1 The grader's own false positives, and the fix

The first full run reported `traps 0.0%` for all three arms, then — once evidence-mode trap grading
was corrected — `datum 2/4`. Both numbers were the grader's, not the systems'. Two distinct defects,
found by running and both now closed:

**Traps were unwinnable by construction.** Evidence mode graded a trap by testing whether the
retrieved context *was* a refusal. A pile of retrieved records can never be a refusal, so all four
traps were lost by every arm in every regime. In evidence mode a trap is now won by **not surfacing
the tempting value**.

**A bare number is not evidence of anything.** An unanchored numeric `forbid` fires on any occurrence
of those digits. Measured over the 550-utterance corpus, it fired on:

| entry | what it actually matched | scored as |
|---|---|---|
| `44` | *"est bake **44** layers"*, *"PR 43 **44**"* | an OpenRouter token price |
| `85` | *"**85** unmeasured claims"*, *"spent **85** on gpu"* | an MTP acceptance rate |
| `48` | *"was at **48** gb"* | an MTP acceptance rate |
| `55` | *"54 scheduler coalescing **55** indexer loader"* | a B200 throughput figure |

Every one is a false positive — layer counts, a pull-request number, list indices, a memory reading, a
dollar figure — and between them they cost `datum` two traps and `grep` and `full-context` one each. A
benchmark whose headline anti-hallucination metric fires on a list index is measuring its own grader,
and this project exists to catch exactly that class of clean-looking wrong number.

An all-numeric entry now trips only with a `forbid_subject` token within 12 tokens: `E37` anchors on
`million|price|pricing|charge`, `E38` on `acceptance|mtp`, `E40` on `b200|b300|aggregate`. `E39` needs
none, because `us-east` cannot float. `verify.mts` refuses any trap that declares an all-numeric
forbid without a subject. Three adversarial cases hold the line in both directions: a list-index
occurrence that must **not** contaminate, the same value attached to its subject that **must**, and a
value five tokens from its subject inside real corpus prose that must.

Anchoring is scoped to where it is needed. An answerable question's `forbid` stays unanchored, because
it is only ever applied to a one-sentence assertion and never to a retrieved context, so a bare number
in it is an answer attempt rather than a passing digit.

**A third defect fell out of the same investigation.** `grade.md` §4's abstention test disqualified a
refusal that "smuggled in a candidate value", implemented as a loose numeric scan. It rejected
`Not on record. Nearby the log reads: 84 explainer terms, 3 crash fixes, 85 unmeasured claims` as a
smuggled answer, because a list index equalled a forbidden value — a correct refusal scored as a
hallucination. Clause 2 now reuses the scoring matchers and inherits the anchoring.

And the abstention test should never have run in evidence mode at all. It was firing on **corpus
vocabulary**: `I don't know` is something Jish actually says, so an arm returning irrelevant records
containing it was credited with a refusal it never made. Ten such rows existed across the two regimes,
every one with non-zero units. In evidence mode the only abstention is now an **empty result**.

## 5. The two query regimes

Both mechanical, both applied identically to all three arms, and which one produced a number appears
beside it.

**`derived`** — content terms from the **question**: stopwords and sub-4-character tokens dropped,
digit-initial dropped, sorted rarest-first by document frequency over the corpus, first four kept.
Nothing hand-tuned per question, for either the baseline or the subject.

This regime is hard for an honest reason: the questions **deliberately paraphrase**, because a
question reusing the corpus's own wording leaks its answer into the query. E01's terms come out as
`accused, walking, side, claim` against an utterance reading `you said 600 tok/s how is now that 40?`.
That vocabulary gap is a real property of the problem — the person asking "what did I decide about the
bit width" does not remember typing "why 2.25 bits".

**`topic`** — an **oracle-topic upper bound**, labelled as one everywhere. Terms are the rarest
content terms of the ground-truth utterance with every `expect`/`forbid` token removed. It models the
person who remembers what the conversation was about but not the value. It never contains the answer,
but it is built from the answer's record, so it guarantees the target contains the terms and reduces
the task to ranking one record out of 542. It is a bound, not a result.

Two questions are **unanswerable by construction** in `topic` and this is stated rather than smoothed:
E14 (`Ban greedy forever`) and E33 (`Three agents died.`) are so short that removing the answer tokens
leaves no term of four characters or more. The query is empty and every retrieval arm abstains. That
caps `topic` at 38/40 for `grep` and `datum` alike, and it is the whole of datum's `topic` loss.

## 6. Results

`--repeats=3`, evidence answerer (the retrieved context *is* the response, so a verdict is the arm's
accuracy **ceiling** — a faithful reader cannot answer from evidence it was never shown).

**`derived` — the headline regime.**

| arm | acc | ±sd | wrong | abstain | trust | traps | contam | tok/q | ms/q | unstable |
|---|---|---|---|---|---|---|---|---|---|---|
| `grep` | **22.5%** | 0.0 | 77.5% | 0.0% | −55.0% | 2/4 | 10.0% | 19,263 | 1,418 | 0 |
| `full-context` | **97.5%** | 0.0 | 2.5% | 0.0% | +95.0% | 3/4 | 10.0% | 72,633 | 0 | 0 |
| `datum` | **62.5%** | 0.0 | 37.5% | 0.0% | +25.0% | **4/4** | 5.0% | 11,939 | 32 | 0 |

**`topic` — oracle upper bound.**

| arm | acc | ±sd | wrong | abstain | trust | traps | contam | tok/q | ms/q | unstable |
|---|---|---|---|---|---|---|---|---|---|---|
| `grep` | **65.0%** | 0.0 | 30.0% | 5.0% | +35.0% | 3/4 | 10.0% | 16,506 | 1,292 | 0 |
| `full-context` | **97.5%** | 0.0 | 2.5% | 0.0% | +95.0% | 3/4 | 10.0% | 72,633 | 0 | 0 |
| `datum` | **95.0%** | 0.0 | 0.0% | 5.0% | +95.0% | **4/4** | 5.0% | 10,164 | 12 | 0 |

Variance is **0.0 across all three repeats for all three arms in both regimes**, and 0 questions
changed verdict between repeats. Both `grep` and the evidence answerer are deterministic and datum's
index is static for the run, so 0 is the expected result — and per `grade.md` §6 a non-zero figure
here would mean the run was broken, not that a system was noisy. The `derived` table reproduced
bit-identically across separate process invocations.

### The verdict against the gate

The gate is *beat both full-context and file-plus-grep by ≥10 points*.

- vs `grep`: **+40.0** points (derived), **+30.0** (topic). Clears it in both regimes.
- vs `full-context`: **−35.0** points (derived), **−2.5** (topic). Fails it in both regimes.

**Episode retrieval does not clear the stop gate on this corpus.** It is not close in the headline
regime. The honest reading is that this corpus is 264 KB — small enough that handing over everything
is both affordable and near-perfect, which is exactly the MemoryBench finding that no memory system
consistently beats simply using all task context. The bar was set knowing that. Correcting the grader
moved every arm up and did not move this verdict.

What retrieval buys is **cost, latency and refusal at near-parity accuracy in the oracle regime**:
95.0% against 97.5% for 10,164 tokens instead of 72,633 (7.1×), 12 ms instead of a 264 KB payload,
half the contamination, and the only clean sweep of the abstention traps. That is a real engineering
result, it is not the result the gate asks for, and it does not survive the `derived` regime where the
same system drops to 62.5%.

### Where each arm loses

**`grep` (derived, 22.5%).** It cannot bridge the vocabulary gap at all: `only_in_transcript` accuracy
is **0.0%**, and trust is **−55.0%** — wrong on 31 of 40, right on 9. Four term-searches over 668 MB
of raw records return 40 windows of confidently irrelevant text. Given the real words (`topic`) it
recovers to 65.0%, which measures how much of `grep`'s published strength is the benchmark handing it
the corpus vocabulary. It is also the slowest arm by two orders of magnitude, 1,418 ms per question
against datum's 32.

**`full-context` (97.5%, both regimes).** Loses exactly one question, and it is a trap: **E40**. It is
structurally incapable of refusing — the response is the corpus, so a trap is lost the moment a
forbidden value is inside it. See §6.1, because *which* value reaches it is the most interesting result
in this benchmark. It also costs 2,905,320 input tokens per 40-question pass, 6.1× datum's 477,549,
and carries double datum's contamination at 10.0%: handing over everything hands over every superseded
number alongside the live one.

**`datum` (derived, 62.5%).** Loses 15, all `wrong`, and they split cleanly. Eight are the vocabulary
gap — E16, E18, E19, E20, E21, E24, E25 and E06, where paraphrased terms retrieve records that do not
contain the answer. Seven are ranking failures where plausible neighbours came back but the target did
not: E01, E05, E08, E22, E32, E33, E35. In the `topic` regime all fifteen recover and the only two
losses are E14 and E33, both of them the structurally-empty query of §5 rather than a retrieval
failure. **It is the only arm that takes all four traps, in both regimes.**

The `matched` tiers are worth the separate reporting. In `derived`: 243 phrase, 171 fts, **135
trigram** — a quarter of everything surfaced is a fuzzy trigram hit. In `topic`: 442 phrase, 129 fts,
**0 trigram**. When the query words are real the fuzzy tier stops firing entirely, which says the
trigram tier is carrying paraphrase and carrying it badly. That is where I would look first to move
the `derived` number.

### 6.1 The finding: a human pasting the model's text launders an invented number into testimony

`full-context` fails exactly one trap, **E40** — *"What aggregate tok/s figure did Jish commit Arc to
on B200 or B300 hardware?"* — and the value it surfaces is real prose from the corpus:

> `4eba13905`, 55 tok/s, +46% on B200, Qwen3-32B

Jish never said that. It is the model's claim, and it reaches the human-utterance corpus because it
sits inside **two `/compact` continuation summaries** (`4d267202:16541` and `4d267202:19872`), which
arrive in the user slot as plain text. Anchored to `b200` five tokens away, it is a genuine
contamination, and any system that stores those records as testimony from a named human will answer a
question about what the human committed to with a number the model invented.

**`datum` passes E40 for one reason only: the ingest path drops `isCompactSummary` records.** That
exclusion, made for an unrelated reason — a 15–21k-character document that has already discarded its
qualifiers would outrank every real sentence by length — turns out to be load-bearing for the
anti-hallucination metric. It is the difference between 4/4 and 3/4 on traps.

**Is the mechanism visible elsewhere? Yes, and it is pervasive.** Measured over the 550 human
utterances, machine-authored prose arriving in the user slot accounts for **23 records — 4.2% of the
corpus by count and 211,686 of 253,912 characters, 83.4% by volume**:

| shape | records |
|---|---|
| `/compact` continuation summaries | 8 |
| box-drawing or markdown tables pasted back | 7 |
| `->` quote-backs, the human quoting the agent to argue with it | 12 |
| other pastes over 1,200 characters | 7 |
| **union** | **23** |

Four fifths of what looks like human testimony in this corpus, by volume, is the model's own words
handed back to it. Datum's exclusion catches the 8 summaries, which is 151,752 of those 211,686
characters. **It does not catch the other 15**, and E31 is the proof that this is not hypothetical:
its source is Jish quoting the agent's own sentence — *"9,000 GPU instructions issued per token where
the competition issues 10–30"* — back at it, and that record is stored as `role: human`,
`actor: human:jish`. The attribution is correct in the sense that Jish typed it. It is wrong in every
sense that matters for provenance.

This is the most important thing this benchmark found, and it is not a retrieval problem. It is an
ingest problem, and it argues that `isCompactSummary` is the easy half of a filter that needs a second
half: **a record whose text the model produced is not testimony, however it arrived**. That is a claim
about the ingest contract, not a change I can make from a benchmark directory, so it is reported here
rather than acted on.

The corollary is the reason the other trap decoys behave differently. `E37`'s
`$44 per million tokens` has **zero** anchored occurrences in the 550 utterances — it exists only in
assistant records, so only `grep`, which reads the raw `.jsonl`, ever surfaces it. That is why `grep`
loses E37 and the other two arms do not, and it is why the arm that reads the most loses the most on
traps.

## 7. The question I think is most likely to be unfair

**E22.** It asks how many PRs Jish wanted left open, which one, and who was allowed to create
branches, and it requires `1 pr`, `openrouter one` and `agents`.

`openrouter one` is the problem. It is a **contiguous two-token phrase lifted from his exact
phrasing** — "I need only 1 PR open - the openrouter one" — and a completely correct answer written
naturally as *"only the OpenRouter PR should stay open, and only agents create branches"* fails,
because `openrouter pr` is not `openrouter one`. The entry is doing double duty: it encodes the fact
*and* it is one of the eight things making the question `only_in_transcript`, since "openrouter one"
is the string absent from the Arc repo. That is a conflict of interest inside a single field, and it
resolved in favour of the label rather than the question. E22 is `wrong` for `datum` in the `derived`
regime and for `grep` in both, so it is costing real points.

E31 is the runner-up for the same reason — `9000 gpu instructions` demands that word order, including
`gpu` — but "9,000 GPU instructions" is at least how a person would naturally write it. "The
OpenRouter one" is not.

The general form of the risk: contiguous phrase matching is what stops `1 second` matching `21
seconds`, and the price is that it also rejects correct paraphrases. §3 of `grade.md` prices that
trade deliberately; E22 is where I think it was priced wrong.

## 8. What this instrument does not measure

- **Answer accuracy with a real reader.** The default answerer is `evidence`: the retrieved context is
  the response, which measures retrieval sufficiency — the arm's ceiling. `--answerer=llm` with
  `BENCH_ANSWERER_URL`/`BENCH_ANSWERER_MODEL` grades a real answer string under the same rules with
  `forbid` fully live and abstention detection active. **It was not run**, because no answerer
  endpoint was configured in this environment. Every number in §6 is a ceiling, not an achieved
  accuracy.
- **Polarity.** See §4. A negated sentence carrying the right tokens grades `correct`.
- **Anything about promotion.** No code here creates an assertion from an episode. The benchmark reads
  `/v1/episodes` and nothing else, and the invariant that an episode can never be `measured` or
  `derived` evidence is not something a measuring instrument gets to test by writing.
- **Ranking quality below the retrieved window.** An arm that returns the right record 21st out of a
  limit of 20 scores identically to one that returns nothing.
- **Whether the 15 non-summary pastes of §6.1 harm real use.** The benchmark detects them and one of
  them is a question source; it does not measure what they cost.
