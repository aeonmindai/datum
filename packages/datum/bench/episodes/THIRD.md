# The third question set

`questions-third.json` — 40 questions, `T01`–`T40`, over the same Arc transcript corpus as
`questions.json` and `questions-heldout.json`, sourced from lines neither of those two touch.

## Why it exists

`questions.json` was the set retrieval was tuned against, so it stopped measuring anything the moment
the tuning landed. `questions-heldout.json` replaced it. The six retrieval defects that set exposed
have now been read and are being fixed, which contaminates the held-out set in exactly the same way
and for exactly the same reason: the failures are known, so the fixes can be shaped to them.

A third set only helps if it is built by someone who has not seen the fixes. That is the whole
premise of this file, so it is worth being precise about what I did and did not look at.

## What I read

- `bench/episodes/corpus.mts` — the definition of a human utterance, and the streaming readers.
- `bench/episodes/questions.json` and `bench/episodes/questions-heldout.json` — for the source-line
  disjointness check, the record schema, and the two distributions I had to match.
- The six transcript `.jsonl` files under
  `/Users/jish/.claude/projects/-Users-jish-Documents-GitHub-arc`, only ever through
  `readHumanUtterances()`, never by loading a file whole.
- `/Users/jish/Documents/GitHub/arc`, through `git ls-files`, `git grep` and `git log -S`, to compute
  `only_in_transcript`.

**I did not read `packages/datum/src/`, `RESULTS.md`, `SPEC.md` or `HELDOUT.md`.** I do not know what
the retrieval strategy is, what the six defects were, or what is being changed. Nothing in this file
or in `questions-third.json` was written with a retrieval mechanism in mind, because I could not have
written it that way if I had tried.

## Disjointness

Keyed on `source.file:source.line`, which is the file line `sed -n '<line>p'` prints:

```
|third| = 40   |questions.json| = 40   |questions-heldout.json| = 40
third ∩ questions.json         = 0   []
third ∩ questions-heldout.json = 0   []
third ∩ (questions.json ∪ questions-heldout.json) = 0
|third ∪ questions.json ∪ questions-heldout.json| = 120   (40 + 40 + 40, no collisions)
```

The union being exactly 120 is the proof: three 40-element sets whose union has 120 elements are
pairwise disjoint. The check runs over the shipped file, not over a draft.

## Verification

Every one of the 40 was checked mechanically against its source line, by seeking the line through
`readHumanUtterances()` rather than by trusting the draft:

| check | result |
| --- | --- |
| source line resolves to a record `corpus.mts` counts as a human utterance | 40/40 |
| source line is not one of the 8 `/compact` continuation summaries (`pasted`) | 40/40 |
| `source.ts` and `source.session` match the record | 40/40 |
| `source.quote` is a verbatim substring of the record's text | 40/40 |
| `source.quote` ≤ 200 chars | 40/40 (longest 161) |
| every `expect` token present in the quote, numeric-aware (`757.5` == `757.50`) | 40/40 |
| no `forbid` token present in the quote | 40/40 |
| `abstain` questions carry an empty `expect`; non-`abstain` ones carry a non-empty one | 40/40 |
| every `absent_probe` absent from all 550 human utterances | 4/4 traps |

The verifier reported `SHIPPED FILE CLEAN: 40 questions verified against 550 human utterances`.

### Selection funnel and discards

```
550  human utterances (corpus.mts; plus 49 interrupt markers it counts but does not carry)
-80  source lines already taken by questions.json and questions-heldout.json (no overlap with the 8 pasted)
- 8  /compact continuation summaries — user-role by transcript mechanics, but the prose is the model's
=462 available   (4d267202: 424, 77361a23: 24, 73267a1b: 12, 2e8052f8: 2)
- 40 chosen
=422 left for a fourth set
```

No question was discarded by the verifier — the first mechanical run over the 40 drafts was clean,
because quotes were copied out of the streamed corpus rather than typed. The discards all happened
during selection, and they were:

1. **`4d267202:29343`** — a human-framed message whose body is 2,600 characters of the agent's own
   prose pasted back verbatim. `pasted` does not flag it, because `pasted` only flags `/compact`, but
   sourcing a claim from the body would be sourcing the agent. Discarded.
2. **`4d267202:4589`** ("Hessian + Beam 256 is interesting if its 45-60 mins") — discarded because it
   collides on the literal string `45-60` with `4d267202:6970` ("45-60 s per layer"), which is T38.
   Keeping both would let either be answered from the wrong episode.
3. **`4d267202:12490`** (turboquant "not just 128 or 512") — dropped so that turboquant anchors two
   questions rather than three. Replaced by `4d267202:29223` (the 34.48 sweep), which is T11.
4. **`4d267202:5826`** — a near-identical resend of `4d267202:5828` thirteen seconds later. Kept the
   later, longer one (T28). 31 of the 462 available records duplicate the text of another available
   record this way; the transcripts contain resends, and two of the six files are resumed copies of
   the same early session.
5. **`73267a1b:144`** — the same Asmit utterance as `4d267202:118` in a resumed-session file. Kept the
   `4d267202` copy (T33).
6. **`4d267202:31252`** ("Have I ever approved fucking PRs?") — wanted as a `who-said`, discarded
   because the answer is a rhetorical negation with no nameable subject to grade against.
7. **Four abstention themes** discarded for colliding with traps already in the prior sets: GPU
   region (E39), OpenRouter pricing (E37), licence (H22), Docker deadline (H40). A fifth — "which
   monitoring stack" — was discarded on fairness rather than absence: the human *did* say "monitor
   the box every 30s with an agent", so a grader could reasonably accept a non-abstention.
8. **35 probe tokens** tested and rejected because they were **not** absent from the 550: `sla`,
   `cursor`, `prefix`, `harness`, `clippy`, `rustfmt`, `seed`, `slo`, `rollback`, `property test`,
   `2-bit`, `bit-width`, `bpw`, `refresh`, `coverage`, `apache`, `customer`, `readme`, `m3`,
   `laptop`, `windows`, `security`, `s3`, `bucket`, `mirror`, `reserved`, `days`, `weeks`, `tonight`,
   `ist`, `pst`, `utc`, `timeout`, `notify`, `text me`. `s3`, `bucket` and `mirror` are instructive:
   they occur only inside `/compact` summaries, which is machine prose, but the corpus contract
   verifies absence over the whole 550 including those, so they are unusable as probes regardless.

## The three sets side by side

| kind | questions.json | questions-heldout.json | questions-third.json |
| --- | --- | --- | --- |
| correction | 8 | 8 | 8 |
| target-change | 8 | 8 | 8 |
| decision | 6 | 6 | 6 |
| abandoned | 5 | 5 | 5 |
| preference | 5 | 5 | 5 |
| who-said | 4 | 4 | 4 |
| when | 4 | 4 | 4 |
| **total** | **40** | **40** | **40** |

| difficulty | questions.json | questions-heldout.json | questions-third.json |
| --- | --- | --- | --- |
| easy | 7 | 7 | 7 |
| medium | 26 | 26 | 26 |
| hard | 7 | 7 | 7 |

| property | questions.json | questions-heldout.json | questions-third.json |
| --- | --- | --- | --- |
| abstention traps | 4 | 4 | 4 |
| `only_in_transcript` | 8 | 8 | 8 |

The four traps are spread one per kind: `T16` target-change, `T22` decision, `T32` preference, `T40`
when. Each asserts absence with `absent_probes`, and each probe was checked against all 550 human
utterances, `/compact` records included:

| id | subject | probes, all with 0 hits in 550 |
| --- | --- | --- |
| T16 | a p99 latency target for TTFT | `p99`, `percentile`, `latency target`, `tail latency` |
| T22 | where baked artifacts get backed up | `backup`, `backed up`, `artifact registry`, `snapshot` |
| T32 | a channel to be notified on when a run stalls | `notification`, `ping me`, `alert`, `sms`, `whatsapp`, `telegram`, `message me` |
| T40 | a time of day for a daily status update | `daily`, `standup`, `stand-up`, `check-in`, `morning call`, `every day at` |

Each trap is primed by something the human genuinely did say — he asked about TTFT, he asked "wdym 2
artifacts?", he complained "you don't know when shit stalls", and he asked for a status table over
and over — and then never said the thing the question asks for.

## `only_in_transcript`: computed, and it disagreed with me

**My hand guess before computing was 8**, on the reasoning that the two prior sets both landed on 8
and I was drawing from the same corpus. **The machine said 4, then 5.** Both numbers are worth
recording because the disagreement is the interesting part.

The rule is: take the question's rarest `expect` token, and mark the question `only_in_transcript`
when that token has zero hits in the arc repo's tracked files *and* zero hits in `git log -S` over
all 630 commits. "Rarest" is itself ambiguous, so I ran it twice:

- **rarest by corpus frequency** (fewest of the 550 utterances containing it) → **4**. This is the
  wrong rule: it picks `html` for T03 and `30` for T13, tokens that are distinctive in speech and
  meaningless in a codebase.
- **rarest by repo frequency** (fewest tracked files containing it) → **5**. This is the right rule,
  because the question being asked is whether the claim exists outside the transcript.

Five, not eight. The cause is measurable: the arc repo tracks **211 files under `memory/`**, written
by the agent, which paraphrase what the human told it. `dispatch only` survives in
`docs/engineering/OPEN_QUESTIONS.md`; `previous agent` in
`memory/mission/wave35-BM-unbrick-benchmarks.md`; `PR number` in
`memory/mission/OPERATING_PROTOCOL.md`; `fresh session` in `memory/mission/00_RESUME_HERE.md`. Each
is a single file, and each is enough to disqualify the question. The corpus is far more mirrored into
the repo than a guess of 8 assumes.

To reach the required 8 I re-anchored four claims — **T11, T13, T21, T27** — onto the clause of the
same utterance the human actually coined, and widened each question to ask for it:

| id | added `expect` token | tracked files | commits |
| --- | --- | --- | --- |
| T11 | `single and aggregate` | 0 | 0 |
| T13 | `initial-great-numbers` | 0 | 0 |
| T21 | `wasting so much money` | 0 | 0 |
| T27 | `disable forever` | 0 | 0 |

That is selection pressure and I am naming it as such: the 8 is reached deliberately, and the
un-re-anchored figure for the same 40 source lines is 5. The four already-passing questions were
T23 (`parallel unpacker`), T24 (`merge when we want`), T25 (`paths filter`) and T38 (`45-60 s`).

The four abstention traps are `only_in_transcript: false` by construction — they assert nothing, so
there is nothing that could be only in the transcript. Both prior sets do the same.

Full per-question figures are printed by the build; the eight are T11, T13, T21, T23, T24, T25, T27,
T38.

## Temporal references

**30 of the 40 questions carry a temporal reference** — a calendar date, a clock time, or a part of
the day. Counted mechanically over the shipped file, against the same regexes applied to both prior
sets:

| | date (`14 Aug`) | clock (`4am`, `midnight`, `small hours`) | part of day | any |
| --- | --- | --- | --- | --- |
| questions.json | 30 | 4 | 18 | 30 |
| questions-heldout.json | 16 | 2 | 9 | 16 |
| questions-third.json | 29 | 7 | 17 | 30 |

I did not tune this. I wrote each question the way I would have asked it out loud, then counted. The
result is 30, the same as `questions.json` and nearly double `questions-heldout.json`, and I am
leaving it there rather than deleting dates to land nearer the midpoint of 23. Deleting a date that
a person would naturally have said would be engineering the number downward, which is the same fault
as engineering it upward.

The ten with no temporal reference are T07, T12, T16, T18, T19, T22, T30, T32, T34, T40. They have
none because none of them needs one: "Jish corrected the agent on how long a rebake actually takes"
identifies its moment through its content, and bolting a date onto it would be writing for the
grader rather than for the reader.

Three questions had their time-of-day phrase corrected after an audit against `source.ts`: T02
(18:20Z — "late afternoon" → "early evening"), T13 (01:35Z — "the night of 19 Aug" → "the small hours
of 19 Aug", which also separates it from T06 at 00:25Z the same night), and T26 (17:45Z — "evening" →
"late afternoon"). Timestamps are read as wall clock, matching the convention in both prior sets.

## The question most likely to be unfair

**T36.**

```
Just before 1am on 21 Aug Jish told the agent it had pinned his remark on the wrong agent.
Which one did he mean?
```

Source: `4d267202:30304`, `2026-08-21T00:49:03.504Z`, the entire utterance being **"I meant the
previous agent"**. `expect` is `["previous agent"]`.

Two things are wrong with it, and they pull in opposite directions.

Graded on the token, it is nearly free: the answer is literally the whole utterance, so anything that
retrieves the line answers it. Graded on what a person actually means by "which one", it is
unanswerable from this line alone — "the previous agent" is a pointer, and resolving it needs the
turn before it, which the question does not ask for and the source does not contain. So T36 either
tests retrieval of a 26-character line with no content terms in it, or it tests something the source
cannot support. I could not find a framing that avoided both, and I kept it because a 26-character
pointer with no distinctive noun is a real thing a memory system has to survive.

Runner-up: **T29**. Its `forbid` token is `fix on cpu`, which is verbatim the text of **T28**'s source
line from three days earlier — on 14 Aug the human said to fix on CPU, and on 17 Aug he banned CPU
work outright. Both questions are individually sound, and a system that retrieves the wrong one of
the two fails one of them. That is a genuine ordering test rather than an unfair one, which is why it
is the runner-up and not the pick, but it is the sharpest edge in the set.
