# M2 coverage — what an instrument can and cannot reach

M2's store-only arm scored **90.9%** against a 94.4% bar with **zero wrong answers in 66
question-instances**. It lost on coverage: three of four misses were facts nobody had asserted
(`S07`, `S09`, `S10`). The cheap repair is to type those three in. This is the other repair —
read facts off artifacts mechanically — and the result has to be reported in two separate numbers,
because they are very different numbers.

Every figure below was produced by running the code in `packages/datum/src/instruments/` or a
command against the trees named. Nothing here is estimated.

---

## 1. The investigation: what structured artifacts actually exist

Arc at `526c909986de48b13d4ae33964baf0451fb79270` (committed 2026-08-24T15:12:08+01:00),
**1,825 tracked files**.

| class | count | where |
|---|---|---|
| tracked structured config | **173** — 126 `.json`, 35 `.toml`, 6 `.yaml`, 6 `.yml` | tree-wide |
| …plus `.txt` / `.log` | **210** total | |
| benchmark / instrument result JSON | **50** JSON in **86** files | `memory/mission/gpu-run{1..5}-results/` |
| profiler output, captured | **1** file | `memory/mission/gpu-run4-results/results/decode_profile_s4.txt` (`ARC_TIME_DECODE` per-step breakdowns) |
| CI workflows | **9** | `.github/workflows/` |
| compiler config | **1** | `.cargo/config.toml` (`target-cpu=native` for every target) |
| Rust `const`/`static` declarations | **856**, of which **149** carry a bound-shaped name | `mistralrs-*`, `arc-*` |
| C/C++/CUDA `static_assert` | **108** | `mistralrs-paged-attn/src/cuda/**` mostly |
| pinned reference repos | **53**, each its own git checkout at its own commit | `research/code` → symlink to `/Users/jish/Documents/GitHub/arc-research-code` |

The last row was the find. `research/code` is **not part of Arc's git history** — it is a symlink to
a directory of 53 independently pinned upstream checkouts (SGLang, vLLM, FlashInfer, FlashMLA,
TensorRT-LLM, QTIP, …). SGLang sits at `c5251a98a9d499d600beb557835ac5874e0c3f36` (2026-05-21) and
is 5,596 files. Anything read out of it must carry **that** repo's sha, not Arc's, or the
verification worker gets evidence it can never resolve.

### The three known misses, checked by id against `bench/m2/questions.json`

| id | question | `expect` | `poison` | mechanically recoverable? |
|---|---|---|---|---|
| `S07` | Is b=1 latency-bound or instruction-bound? | `instruction` | `latency`, `memory-bound`, `4%` | **No** |
| `S09` | What does clone_in_cache actually cost per step? | `572` | `28.3` | **No** |
| `S10` | What page_size does SGLang use for V4? | `256` | `page_size=1` | **Yes** |

**`S10` — yes, and it falls out of the machinery rather than being typed in.** SGLang pins it in
source, three times, with a message:

```
python/sglang/srt/layers/attention/deepseek_v4_backend.py:355
python/sglang/srt/layers/attention/deepseek_v4_backend_hip_radix.py:349
python/sglang/srt/layers/attention/dsv4/metadata.py:134
    assert self.page_size == 256, "the system hardcodes page_size=256"
```

plus the defaults hook at `python/sglang/srt/arg_groups/deepseek_v4_hook.py:16`
(`server_args.page_size = 256`). The generic default is not 256 — `server_args.py:1847,1854` sets
1 or 64 depending on the ROCm path — which is precisely why "SGLang uses page_size=1" was written
down and then retracted. An instrument that read the *default* would have produced the poison; one
that reads the *V4 pin* produces the answer.

**`S09` — no, and the reason is worth recording.** `clone_in_cache` appears **zero** times in any
`.json`, `.log`, or `.txt` anywhere in the Arc tree, including untracked scratch and all
`.claude/worktrees/*`. Every occurrence is in Markdown prose or in Rust source comments. The
`+572 ms/step` figure came from a real instrument — `arc-profiler` emits a `clone_in_cache` span
(`mistralrs-core/src/kv_cache/mod.rs:1712`) and `wave52-CC-profiler.md` documents the tree — but
`arc-profile-report` consumes `RUN.json` files and **no such run file was ever committed**. The
measurement was taken; the artifact was discarded; only the conclusion survives, in
`memory/RETRACTED.md:55`. Ten structured files do contain the digits `572`, and all ten are
incidental substrings of unrelated floats (`152.00572` ppl, `3.572` s ttft, `377.66454786195**72**`
GB/s). No instrument can recover this fact from this repo.

**`S07` — no, and not for a fixable reason.** "Latency-bound or instruction-bound" is a *verdict
about a mechanism*, not a value in a field. No structured artifact carries either token
(`grep -lE 'latency.bound|instruction.bound'` across all 210 → zero). The underlying evidence for
it — `S03`'s 86 casts/launches per token — is a count somebody derived by reading kernels, not a
number any file states.

### The loud finding: existing structured artifacts already carry poison

The parent asked whether any config artifact carries a `poison` value. Several do, and one is
egregious:

| artifact | field | value | poison for |
|---|---|---|---|
| **9** result files, `memory/mission/gpu-run{1..4}*/results/speed_*.json` | `summary.june_anchor_decode_tok_s` | **640** | `C02` (measured single-user tok/s; correct answer 44.68) |
| the probe that writes them, `arc-tools/quality/speed_probe.py:63` | same key, **hardcoded** | **640** | `C02`, on every future run |
| `memory/mission/CEILINGS.json` | `SPEED_MODEL.headline_ceiling` | "~**16,600** tok/s aggregate at B=256" | `S04`, `C01` |
| `memory/mission/CEILINGS.json` | `SPEED_MODEL.table[].ceiling_aggregate_tok_s` | **16602**, **1413** | `S04`, `S12`, `C09` |
| `memory/STATE.json` | `targets.single_user_tok_s.ceiling` | "**1413** at 2.09 bpw" | `C09`, `S12` |
| `memory/STATE.json` | `targets.aggregate_tok_s_at_b256.value` | **14000** | `C01` |

`june_anchor_decode_tok_s: 640` is the dangerous one. It sits in the `summary` block of a
speed-probe *result* file — exactly the shape a naive "ingest benchmark JSON" instrument would
walk — under a key that reads like a measurement, beside two keys that genuinely are one
(`decode_tok_s_best`, `prefill_tok_s_best`). Nine of them. And it is not stale data that leaked
in: `speed_probe.py:63` writes the literal `640` into every summary it produces, so the field is
not a measurement that went dead, it is a comparison anchor that has always been a target and is
shaped exactly like a result. Writing it as a live fact reproduces C02's poison with a machine's
authority behind it, and would keep doing so for every probe run from here.

**This is why there is no benchmark-result-JSON reader in this subsystem.** The 50 result files
are the richest artifact class in the repo and they are unusable as-is: nothing in them
distinguishes a live number from a dead one, and `STATE.json`'s `14000` is only correct because
its *key* says `targets` — read it as a measurement and it becomes C01's poison. That is not a
parsing problem; it is the absence of the kind/confidence distinction the store exists to supply,
and no reader can invent it.

---

## 2. Facts added

`readConfigFacts` reads three constructs and nothing else, because these are the ones whose
meaning is unambiguous without executing the program:

| construct | kind | why that kind |
|---|---|---|
| `static_assert(X == N)` (C/C++/CUDA) | `constraint` | the build fails on any other value |
| `assert X == N, "msg"` (Python) | `constraint` | the run fails on any other value |
| `timeout-minutes: N` (workflow) | `constraint` | the job is killed at N and the run fails |
| `const NAME: T = N;` (Rust) | `state` | nothing refuses a different value; a commit may change it |
| `.cargo/config.toml` build flags | `state` | configures the build; nothing can violate it |

Facts run, at the commits above:

| | Arc | SGLang | total |
|---|---|---|---|
| rust const limit (`state`) | 128 | 22 | 150 |
| cargo config flag (`state`) | 4 | 0 | 4 |
| C/CUDA `static_assert` (`constraint`) | 25 | 22 | 47 |
| Python `assert` (`constraint`) | 0 | 150 | 150 |
| CI `timeout-minutes` (`constraint`) | 3 | 279 | 282 |
| **total** | **160** | **473** | **633** |
| distinct files cited | 88 | 172 | 260 |
| facts folding repeat sites | 17 (+34 extra `file:line`) | 39 (+81) | 56 (+115) |

**633 facts**, each with a `file:line` in `evidence.source`, `evidence.commit`, and
`evidence.path`, all at `confidence: unverified`. 53 reference repos exist; two were read. The
other 51 are one call each.

Deliberately not emitted, and each case is covered by a test: a const whose value is an expression
(`DERIVED_LIMIT = CACHE_GROW_SIZE * 4`), a const whose name denotes no bound (`GREETING`), a
commented-out const, a Python `assert` with no message, `static_assert(sizeof(int) == 4)`, and
`static_assert(HEAD_SIZE == 128 || HEAD_SIZE == 256)` — a real constraint, but not the fact
"HEAD_SIZE is 128", and flattening it to one value would be a fabrication.

**One deviation from the brief, stated plainly.** The brief said to assert at `kind: "measured"`
and also said to choose `state` or `constraint` "where that is the truthful kind". Those conflict,
and the second is right: reading `opt-level = 3` out of a manifest measures nothing, and a store
that labels a file read as a measurement has given up the distinction it exists to keep. Every
fact is `state` or `constraint`. `confidence` is never passed at all, so the ingester cannot
request `measured` even by accident.

---

## 3. Did coverage of the M2 question set move?

**Separately, and this is the number that matters: 1 of 33.**

Measured by asking whether a fact's *own subject* is the thing the question asks about, and whether
its value is the expected one:

| id | | evidence |
|---|---|---|
| `S10` | **now answerable** | `page_size` pinned to `256` at three V4 sites, `constraint`, `binding` |
| `S07`, `S09` | still unanswerable | no artifact states them (§1) |
| other 30 | still unanswerable | see below |

A lexical audit — "does any fact's claim text contain an `expect` string" — returns 14 of 33, and
every one of those beyond `S10` is noise: `expect: ["8"]` matches `CACHE_CAP is 8`, and
`expect: ["no","not"]` matches any sentence containing the word "not". That number is reported here
only so nobody quotes it. It is not coverage.

The other 30 questions are not reachable in principle, not merely unreached. They ask for
measurements (`C01`–`C06`, `C13`–`C15`, `S01`–`S03`), targets and human commitments (`C07`–`C12`,
`S04`), or provenance verdicts (`P01`–`P04`, `S08`, `S11`–`S14`). Pinned constants, compiler flags
and CI timeouts cannot express any of those three things. That is a judgement about the question
set, not a measurement, and it is the honest reading: **633 facts moved the M2 score by at most one
question, and one question is 3.0 points — which would take store-only from 90.9% to 93.9%, still
below the 94.4% bar.** Whether it moves it at all depends on retrieval surfacing the right one of
several `page_size` facts, which this work did not test.

### One thing to watch, and it is the same finding as §1

The instrument emits **6 facts asserting `page_size == 1`**, at
`dsa/dsa_indexer.py:467`, `flashattention_backend.py:2460`, `xpu_backend.py:959`,
`mamba_radix_cache.py:438`, `memory_pool.py:2032`, and
`unified_cache_components/mamba_component.py:45`. `page_size=1` is `S10`'s **poison literal**.

These are not poison — they are true facts about the Mamba, XPU and DSA paths, and refusing to
record them would be censoring the tree. What separates them from the answer is only the file path,
carried in the subject (`pin/<file>/page_size`) and in the claim text. Retrieval that matches
`page_size` without weighting the path can return `1` to a question about V4. The V4 facts also
match `deepseek_v4` / `dsv4`, so a term-weighted search should rank them first — but that is an
argument, not a measurement, and it is the one thing here worth testing before anyone leans on
`S10` as a pass.

---

## What this says about the gate

The mechanical route works, it is cheap, and it does not reach the questions M2 asks. 633 facts
bought at most one of 33, because M2 asks what the system *measured*, *targeted* and *retracted*,
and artifacts on disk state what the system *is configured to do*. Two of the three known misses
are unrecoverable from any artifact in the repo — one because the profiler's output was thrown away
and only the prose conclusion kept, one because it was never a value in the first place.

So the finding stands as `reports/m2-benchmark.md` §"Recommendation" option 3 already suspected:
**for this question set, store-only coverage cannot be closed without human curation.** What
changed is that the claim is now measured rather than assumed, and the reason is specific — not
"seeding is expensive" but "the artifacts that would answer these questions were never written, and
the ones that were written carry the retracted number in ten files under a key that reads like a
measurement."
