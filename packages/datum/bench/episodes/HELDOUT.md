# The held-out set — `questions-heldout.json`

40 questions (`H01`–`H40`) over the same corpus as `questions.json`, built to the same rules by a
worker that has not read `packages/datum/src/` and does not know how retrieval works. The point is
a control group: the `E` set has been scored and read, so any improvement measured on it is
contaminated. This set was never scored before it was written.

**Nothing under `packages/datum/src/` was read.** No file was read to make a question answerable.
The only things read were `bench/episodes/corpus.mts` (to reuse the one definition of a human
utterance), `bench/episodes/questions.json` (to copy the schema and collect the used source lines),
the six transcripts, and the Arc repo's tracked files via `git grep` / `git log` for the
`only_in_transcript` computation. `questions.json`, `grade.md`, `grade.mts`, `run.mts`,
`verify.mts`, `corpus.mts`, `results*.json` are byte-identical; `git status` on this directory
reports exactly one untracked addition per new file.

The corpus was read through `corpus.mts`'s `readHumanUtterances()` — not a second implementation —
so the two sets agree on what counts as speech: **550 human utterances, 49 interrupts, 253,912 bytes
of text**, streamed line by line, never loaded whole.

---

## 1. Disjointness proof

Every `(source.file, source.line)` pair in `questions.json` was collected first; the held-out set
was drawn only from utterances not in that set. Checked mechanically at build time:

```
== disjointness vs the E set ==
  E ids: 40  H ids: 40  id overlap: 0
  E (file,line) keys: 40  H keys: 40  overlap: 0
  H keys internally unique: true
```

The build aborts if any of the three fails. `E` ids are all `E##` and held-out ids are all `H##`,
so id collision is impossible by construction as well as by measurement.

Worth noting what the check bought, because it is not decorative. The two sets sit in the *same*
conversational neighbourhoods without sharing an utterance — `E` sources `4d267202:7413`, this set
`7421`; `E` sources `26923`, this set `26926`; `E` sources `9432` and `9447`, this set `9439`. That
is a stronger comparability property than drawing the held-out set from a different week of the
transcript would have been: both sets sample the same arguments, on the same nights, at the same
density, and still share no utterance.

One question was killed outright by this check — see the discard accounting below.

## 2. Per-question verification

For each of the 40: seek the stated line in the stated file, parse it, confirm the record really is
a genuine human utterance under `corpus.mts`'s definition (`type == "user"`, `message.role ==
"user"`, a text block, non-empty after trim, none of `isMeta` / `isCompactSummary` /
`isVisibleInTranscriptOnly`), confirm the seek-by-line text is byte-identical to the streamed text,
confirm the `quote` is a verbatim substring and ≤200 chars, confirm every `expect` token appears in
the utterance and no `forbid` token does.

```
== per-question source verification ==
  all 40 verified: record is a genuine human utterance, quote verbatim,
  every expect token present, no forbid token present
```

Token matching is numeric-aware but only across representations of the *same* value: `757.5` also
matches `757.50` and `1400` also matches `1,400`. Rounding is deliberately not accepted — an earlier
version generated `toFixed(1)` variants, which made the forbid token `1.21` "match" the utterance
`1.2x` and produced a false failure on H07. Trailing-zero equality (`Number(s) === n`) fixed it.

## 3. Discard accounting

Nothing was discarded for failing source verification: every question that reached the file passed
on the first check-run, and the two problems the checker did raise were defects in the checker or in
a quote's length, both fixed rather than papered over (the rounding bug above; one 208-character
quote trimmed to 189 and re-verified verbatim). Eleven candidate questions were dropped before that,
for four reasons:

| # | Source | Why discarded |
|---|---|---|
| 1 | `4d267202:7828` — *"H200 is 141gb nigga"* | **Killed by the disjointness check.** This is a lovely one-line correction and I drafted a question on it before running the check. It is already an `E`-set source. The only reason I caught it is that the check is mechanical; grepping the corpus for `141gb` returns three human utterances, and the other two are `/compact` pastes, so by eye this looked unclaimed. |
| 2–3 | `4d267202:5058` and `4d267202:8011` | **Machine prose the human merely pasted.** 24,726 and 17,020 bytes respectively, of which almost all is the assistant's own writing, pasted back in to survive a compaction. `corpus.mts`'s `pasted` flag does not catch these — it flags only the 8 `/compact` continuations — so this was a judgement call, not a check. A question sourced here would be asking what the model said while pretending to ask what the human said. |
| 4–5 | `4d267202:169` (*"within 10 hours of your autonomous work fable?"*) and `4d267202:24107` (*"$30 budget to bring me initial-great-numbers"*) | **Distribution.** Both verified clean. Both are `target-change`, and that bucket was already full at 8. Dropped to hold the shape rather than let the distribution drift. |
| 6–11 | `4d267202:7763`, `4d267202:7739`, `4d267202:14656`, `4d267202:33121`, `4d267202:29175`, `77361a23:1250` | **Their answers are written down in the Arc repo.** All six verified clean at source. The first complete draft computed to only 4 `only_in_transcript`, against a floor of 8, so six questions whose answers a `git grep` finds in tracked files were swapped for six whose answers exist only in the conversation. This is selection pressure toward the metric and it should be stated as such: I did not discover that 8 of my questions were transcript-only, I went looking for questions that were. What I did not do is weaken the measurement to get there — the criterion never moved. |

The replacement pass was also only partly effective, which is worth recording: of the six
replacements, four came back `true` and two came back `false` anyway — H29 (*"eco friendly …
cutting carbon"*) because Jish's next instruction was to write those calculations into a document,
so they are in the repo; H19 (*"loop until alright"*) for the same reason. The corpus documents
itself faster than you can find gaps in it.

## 4. Distributions, side by side

| kind | E set | held-out |
|---|---|---|
| correction | 8 | 8 |
| target-change | 8 | 8 |
| decision | 6 | 6 |
| abandoned | 5 | 5 |
| preference | 5 | 5 |
| who-said | 4 | 4 |
| when | 4 | 4 |
| **total** | **40** | **40** |

| difficulty | E set | held-out |
|---|---|---|
| easy | 7 | 7 |
| medium | 26 | 26 |
| hard | 7 | 7 |

| property | E set | held-out |
|---|---|---|
| abstention traps | 4 | 4 |
| `only_in_transcript` | 8 | 8 |
| distinct source lines | 40 | 40 |

Session spread of the held-out sources: `4d267202` ×34, `77361a23` ×4, `73267a1b` ×2. That skew is
the corpus's, not a choice — `4d267202` holds the overwhelming majority of the 550 utterances.

## 5. Abstention traps

Four questions the corpus genuinely does not answer, each with `"expect": []`, `"abstain": true`,
and a `forbid` set of values the **assistant** stated that the human never did. Each trap's subject
was asserted absent from all 550 human utterances — including the 8 `/compact` pastes, which is the
strict reading, since those pastes are where the assistant's vocabulary leaks into the user role.

```
== abstention traps: subject absent from all 550 human utterances ==
  H21  probes[mmlu=0 mmlu-pro=0 gpqa=0]              forbid_subject[mmlu=0]                        OK
  H22  probes[license=0 licence=0 bsl=0]             forbid_subject[license=0 licence=0 bsl=0]     OK
  H32  probes[temperature=0 top-p=0 min-p=0]         forbid_subject[temperature=0 top-p=0 min-p=0] OK
  H40  probes[docker=0 container=0 dockerfile=0]     forbid_subject[docker=0 container=0]          OK
```

- **H21** — an MMLU release gate. Jish only ever names GSM8K. The forbidden values
  (`MMLU-Pro`, `GPQA`, `LiveCodeBench`) come from a research digest at `4d267202:302`.
- **H22** — which licence Arc shipped under. The forbidden values (`Apache-2.0`, `BSL-1.1`, `MIT`)
  are all in the corpus in the assistant's voice: a git-log line at `4d267202:44`, and
  *"SGLang is Apache-2.0"* at `4d267202:12011`. One honest caveat: while `license`, `licence` and
  `bsl` are 0/550, the substring `licensing` **does** appear in two human-role records —
  `4d267202:27805` and `4d267202:31555` — and both are `/compact` continuation pastes, i.e. the
  model's prose. That is exactly the bait this trap is for, and it is the reason the trap is graded
  on `license`/`licence`/`bsl` rather than on `licensing`.
- **H32** — a serving sampling temperature. Forbids `min-p`, `top-nsigma`, `entropy-adaptive`,
  all from assistant research notes at `4d267202:1169` and `4d267202:4681`.
- **H40** — when the Docker image had to be ready. Forbids `Docker image` and `167`, from the
  assistant's own audit at `4d267202:30055` (*"Every Docker image is built with cudnn … Removing it
  is +167%"*).

## 6. `only_in_transcript` — computed, not asserted

Per question, against `/Users/jish/Documents/GitHub/arc`:

1. `git grep -l -i -F --all-match -e <tok> …` over every `expect` token — a question fails if **any
   single tracked file** contains all of them.
2. The rarest `expect` token by tracked-file count is fed to `git log -S<tok> --oneline` — a
   question fails if the token was ever added to or removed from the repo's history.

`only_in_transcript` is `true` only when both return nothing. Traps have no `expect` tokens and are
recorded `false`.

**Computed: 8 / 40.** The eight are H14, H16, H27, H30, H35, H36, H37, H39 — Jish's typo
*"degerate"*, *"Forget 32 users … you lost the game"*, *"fuck the goal, give me the proper
handoff"*, *"reinventing the wheel"*, the *"lead inference engineer … 10 years"* persona he pasted
into the fresh session, the rule-reading line he quoted back, *"days rather than hours"*, and the
*"balance depleted instances stopped"* message.

**My hand guess disagreed with the machine, badly.** Before running the computation I expected the
first complete draft to land around 8, on the reasoning that conversational numbers like
*"16.57 on b1"* and *"3.6 hours"* and *"400s per layer"* are chat artefacts. The machine said **4**.
The reason is that the criterion is a *conjunction over short tokens*: `git grep --all-match` on
`["37","39"]` matches 324 tracked files, because a repo with 1,825 files contains every two-digit
number in some combination somewhere. Only questions whose answer is a distinctive *phrase* —
a typo, a slur, an insult, a quoted line — clear the bar. That is a fact about the criterion, and
the criterion is the one I was told to compute rather than assert, so it stands as measured. It also
says something real about what the transcript uniquely holds: not the numbers, which get written
down, but the way things were said.

## 7. Full manifest

| id | source | kind | difficulty | only_in_transcript | trap |
|---|---|---|---|---|---|
| H01 | 4d267202:3584 | correction | easy | false | - |
| H02 | 4d267202:9439 | correction | medium | false | - |
| H03 | 4d267202:29217 | correction | hard | false | - |
| H04 | 4d267202:32854 | correction | medium | false | - |
| H05 | 4d267202:21405 | correction | easy | false | - |
| H06 | 4d267202:7695 | correction | medium | false | - |
| H07 | 4d267202:7721 | correction | hard | false | - |
| H08 | 4d267202:26926 | correction | hard | false | - |
| H09 | 4d267202:6849 | target-change | medium | false | - |
| H10 | 4d267202:6983 | target-change | medium | false | - |
| H11 | 4d267202:7043 | target-change | medium | false | - |
| H12 | 4d267202:28060 | target-change | easy | false | - |
| H13 | 4d267202:27217 | target-change | medium | false | - |
| H14 | 4d267202:10315 | target-change | medium | **true** | - |
| H15 | 4d267202:25378 | target-change | medium | false | - |
| H16 | 4d267202:26212 | target-change | medium | **true** | - |
| H17 | 4d267202:9783 | decision | easy | false | - |
| H18 | 4d267202:11737 | decision | medium | false | - |
| H19 | 4d267202:5808 | decision | medium | false | - |
| H20 | 77361a23:1135 | decision | medium | false | - |
| H21 | 4d267202:1819 | decision | medium | false | trap |
| H22 | 4d267202:11424 | decision | hard | false | trap |
| H23 | 4d267202:7421 | abandoned | medium | false | - |
| H24 | 4d267202:7447 | abandoned | easy | false | - |
| H25 | 4d267202:5159 | abandoned | medium | false | - |
| H26 | 77361a23:207 | abandoned | medium | false | - |
| H27 | 4d267202:33773 | abandoned | hard | **true** | - |
| H28 | 4d267202:2780 | preference | easy | false | - |
| H29 | 4d267202:9480 | preference | medium | false | - |
| H30 | 4d267202:26831 | preference | medium | **true** | - |
| H31 | 4d267202:13747 | preference | medium | false | - |
| H32 | 4d267202:10258 | preference | hard | false | trap |
| H33 | 73267a1b:191 | who-said | medium | false | - |
| H34 | 73267a1b:44 | who-said | easy | false | - |
| H35 | 77361a23:72 | who-said | medium | **true** | - |
| H36 | 4d267202:15962 | who-said | hard | **true** | - |
| H37 | 4d267202:29309 | when | medium | **true** | - |
| H38 | 77361a23:1586 | when | medium | false | - |
| H39 | 4d267202:23146 | when | medium | **true** | - |
| H40 | 4d267202:29379 | when | medium | false | trap |

## 8. Which of the 40 is most likely to be unfair

**H07.** Jish wrote *"U sure the kernel stack is just a 1.2x upgrade?"* while the assistant had been
saying `1.21×` all night, so the question — what multiplier did **he** say — turns on a single
digit, and I graded it `expect: ["1.2"]`, `forbid: ["1.21"]`. Under any substring-based grader that
is close to unwinnable in the right direction: a system that retrieves exactly the right utterance
and reports *"he said 1.21×"* trips the forbid, and a system that reports *"1.2x"* satisfies the
expect — but so does the string `1.21`, which contains `1.2`. The item can therefore mark a correct
retrieval wrong and can mark a wrong answer right, depending on which check runs first. I left it
as written for one reason: `E01` has exactly this shape (`expect: ["600","40"]`, `forbid: ["640"]`,
where `40` is a substring of `640`), so the existing set already carries this hazard and matching
the instrument mattered more than my private opinion of it — I have not read the grader and am not
allowed to, so "fixing" it would be guessing at a scoring rule I cannot see. Two runners-up, on the
same theme rather than the same mechanism: **H36**, where the `expect` token is a long verbatim
phrase containing apostrophes (`adding a rule doesn't fix it`) and a model that typographically
normalises `'` to `’` while quoting the line perfectly correctly will score zero; and **H28**,
where the answer is *"he banned the word CPU"* and the forbid is `GPU`, so any answer that explains
the ban by contrasting it with the GPU loses. All three punish a system for how it phrases a right
answer rather than for failing to find it. If the held-out score comes in below the `E` score by a
few points, these are the first three items to read before concluding anything about retrieval.
