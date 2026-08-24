# Findings from building the impact question set

## The acceptance criteria I was handed cited symbols that do not exist

Building `questions.json` required establishing ground truth by hand against
`/Users/jish/Documents/GitHub/arc` at `HEAD = 526c909986de48b13d4ae33964baf0451fb79270`. Two of the
"real known facts to check against" in my own brief do not hold there. `rg -w require_k4v2l16` and
`rg -w QtipGeometry` over the tracked tree return **zero** hits in any source file; both symbols
exist only under `.claude/worktrees/agent-a238f55564aacf41d/`, an agent worktree holding an unmerged
line of work. `memory/STATE.json:183` cites them as live evidence —
`"mistralrs-quant/src/qtip/mod.rs:4189 @4033b8f4b is \`self.require_k4v2l16(\"gather_forward\")?\`"` —
and `git merge-base --is-ancestor 4033b8f4b HEAD` exits non-zero, so that commit is not reachable
from HEAD at all. At `4033b8f4b` the claim is exactly true: `git grep -n require_k4v2l16
4033b8f4b -- mistralrs-quant/src/qtip/mod.rs` returns the definition at `:4519` and four call sites,
one of them `:4189`. At HEAD, `mistralrs-quant/src/qtip/mod.rs:4189` is an unrelated line inside a
codebook-tag parser. So the brief, the corpus and the code disagree, and the code is right. This is
branch work quoted as shipped — the failure mode the design document's bitemporality section exists
to catch — reproduced inside the setup of the benchmark meant to test it.

Two things came out of it rather than being routed around.

**It became the bitemporal question.** `I40` is pinned to `4033b8f4b` and its ground truth is the
four symbols that reach `QtipLayer::require_k4v2l16` at that commit, read out of
`git show 4033b8f4b:mistralrs-quant/src/qtip/mod.rs`: `dequantize_weights` (`:2901`), `forward`
(`:4139`), `gather_forward` (`:4188`), `dequantize_expert` (`:4545`). At HEAD the target does not
exist. No snapshot index can hold both answers, and a system answering it must say which commit it
answered for. `I23` is the control: `Pipeline::cuda_graph_runner_mut` has the same nine-file answer
set at both commits while every line number moved (trait declaration `pipeline/mod.rs:703` → `:615`,
`NormalPipeline` impl `normal.rs:3234` → `:2858`), so line drift alone is not a bitemporal
difference and a report that conflates the two has not tested the claim.

**It fixed the indexer scope.** `.claude/worktrees` is a near-complete second copy of Arc. Walking it
would give almost every symbol a duplicate and collapse `unique-name` resolution into
`ambiguous-name` nearly everywhere, erasing the benchmark's signal. The exclusion set is now agreed
with CodeIndexer and recorded machine-readably in `meta.json`; it is load-bearing for comparability,
not documentation.

## Arc maintains its own dead-symbol oracle, and it has drifted

`mistralrs-core/tests/capability_reachability.rs` carries `DEAD_SYMBOL_BASELINE`, a human-maintained
list of symbols with no production reference, cross-checked in-file against rustc's own `dead_code`
pass. It is an independent oracle for the `zero-callers` and `test-only` classes and five questions
coincide with its entries (`I27`, `I30`, `I31`, `I32`, `I33`). It was used as a place to look, never
as the answer: every line was re-verified at HEAD, and two of its comments have drifted.

- The `cuda_graph_runner_mut` entry says "implemented by all eight pipelines". I read nine
  `impl Pipeline for X` headers at HEAD: Embedding, Speculative, Normal, AnyMoe, Vision, Diffusion,
  GGUF, GGML, Speech.
- The `assign_row_lens` entry cites `kv_cache/mod.rs:3127` for its second test caller. At HEAD that
  reference is at `:3327`.

Neither is a defect in the test — it scans for the symbol, not the line — but both are reminders that
a hand-maintained line number is stale the moment it is written, which is the argument for deriving
this from a parser.

## Two corpus contradictions worth reporting on their own

`extend_draft_kv` (`I32`) has zero call sites at HEAD. `docs/engine-explainer.html:1668` tags it
`st:"shipped"`, and `memory/mission/wave42-BT-mtp-working.md:102` cites line numbers for it as
"fixed". The prose asserts a live feature; the instrument finds no caller.

`batch_can_be_ragged` (`I11`) is cited in the corpus at three different line numbers —
`kv_cache/mod.rs:1204` in `memory/mission/_salvage-from-unversioned-copy.md`, `:1227` in
`memory/mission/00_RESUME_HERE.md` and `memory/mission/FACTS.md`. At HEAD it is `:1273`. The corpus
disagrees with itself; the code does not.

## Scale of the gap the benchmark is measuring

Across the 40 questions there are **472** textual hits for the target names, **367** of them in
files with an indexed extension, against **85** correct answers. Reported honestly, the gap is not
uniform, and where grep does fine it is worth saying so:

- Ten questions have an empty correct answer set. On five of them (`I35`-`I39`) the target's name
  occurs exactly once in the whole scoped tree — its own definition — so the `grep-line` baseline,
  which drops the definition line, scores a clean 1.0. Those questions are not there to beat grep;
  they are there because a system that cannot report an empty closure will fail them while grep
  passes, and that asymmetry is worth having in the set.
- Four have textual hits beyond the definition and still no referrer: `I30`
  `prefill_chunk_is_intermediate` (7 code hits), `I31 arc_launch_gemv_bf16_silu_mul_down` (4),
  `I32 extend_draft_kv` (4), `I33 run_target_forward` (4).
- The gap is widest where prose and doc comments name a symbol heavily: `I22` `gather_forward` has
  146 code hits across 26 files against 9 correct answers, `I12 xs_per_sequence_enabled` has 19
  against 6, `I11 batch_can_be_ragged` has 12 against 3, `I10 require_normal_kv_slot` has 6 against 2.

Three cases are worth naming individually because of *how* they mislead.

- `I30 prefill_chunk_is_intermediate` — seven hits, zero referrers. Four are synthetic call sites
  written *in quotes* inside `capability_reachability.rs`'s own fixture
  (`"    let x = prefill_chunk_is_intermediate();"`), placed there to catch a scanner that counts
  text. Arc's baseline records the underlying defect: the flag is written and never read, so with
  `ARC_PREFILL_CHUNK` set every intermediate chunk still samples a token.
- `I33 run_target_forward` — the live function next to it is `run_target_forward_batch`, whose name
  *contains* the target's. Any search without a word boundary reports its call sites as impact. Even
  with `-w`, the surviving hit is a `` [`run_target_forward`] `` doc-link sitting inside
  `run_target_forward_batch`'s own doc comment, so the most natural grep answer names the live
  function as affected. It is not.
- `I34 print_banner` — the Rust `pub fn` at `arc-engine/src/lib.rs:96` has no referrer, while
  `install.sh` defines a shell function of the same name at `:28` and calls it at `:252`. Under the
  baselines defined in `grade.md` this costs grep nothing, because `.sh` is outside the indexed
  extension set — which is the point. It is the case that shows the exclusion set is doing real
  work: widen the extension list by one entry and a text search acquires a confident, wrong caller
  for a function that has none.
