# research-memory-papers

Slice: academic + technical literature on agent memory, and the evaluation side.
All numbers below are quoted from the cited source. Where a number is contested I give every published value.

---

## What exists

### MemGPT / Letta — virtual context management
- arXiv:2310.08560 — https://arxiv.org/abs/2310.08560
- Architecture: OS-analogy. `main context` (the prompt) vs `external context` (recall + archival storage), moved by LLM function calls; "interrupts" hand control between the LLM and the system. Explicitly modelled on virtual-memory paging.
- Deep Memory Retrieval (DMR), built by the authors from Multi-Session Chat: fixed-context GPT-4 **32.1%** → MemGPT **92.5%**; GPT-4-turbo **35.3%** → **93.4%** (https://arxiv.org/abs/2310.08560).
- Nested key-value retrieval: standard GPT-4 hits **0%** at three levels of nesting; MemGPT sustains it via iterative archival lookups.
- The company (Letta) later published the most important negative result in the field against its own benchmark — see "Letta filesystem" below.

### Generative Agents (Park et al. 2023) — memory stream + reflection + retrieval scoring
- arXiv:2304.03442 — https://arxiv.org/abs/2304.03442 ; ACM: https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763
- Memory stream = chronological natural-language log of observations, plans, reflections. Retrieval score is a **weighted sum of recency (exponential decay), importance (LLM self-rated integer), and relevance (embedding similarity)**, with all three weights set to 1 after min-max normalisation. Reflection fires when accumulated importance of recent events crosses a threshold; it queries the LLM with the 100 most recent records, generates candidate questions, retrieves against them, and writes higher-level reflections back into the same stream.
- Ablation (TrueSkill μ, 100 ranking sets): full architecture **μ=29.89, σ=0.72**; no reflection **26.88**; no reflection+planning **25.64**; human crowdworker baseline **22.95**; no memory+planning+reflection **21.21**. Effect size full-vs-fully-ablated **d = 8.16**. Kruskal-Wallis **H(4)=150.29, p<0.001**; all pairwise Dunn tests p<0.001 except crowdworker vs fully-ablated.
- This is still the most-copied retrieval scoring function in the field and the only one with a clean component-wise ablation.

### Zep / Graphiti — temporal knowledge graph, and the only real bitemporal agent memory
- arXiv:2501.13956 — https://arxiv.org/abs/2501.13956 ; source: https://github.com/getzep/graphiti
- Three-tier graph: episode subgraph (non-lossy raw messages), semantic entity subgraph (entities + facts as edges), community subgraph (label propagation, chosen over Leiden specifically because it extends dynamically).
- **Bitemporality is real and explicit**: "Zep implements a bi-temporal model" tracking **four timestamps** — `created_at`/`expired_at` (transaction/ingestion time) and `valid_at`/`invalid_at` (the range over which the fact held true). Verified in source: `graphiti_core/edges.py` `EntityEdge` carries exactly `created_at`, `expired_at`, `valid_at`, `invalid_at`, `reference_time`, `episodes`, `attributes` (https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py).
- **As-of queries exist at the API level**: `graphiti_core/search/search_filters.py` `SearchFilters` exposes `valid_at`, `invalid_at`, `created_at`, `expired_at` as `list[list[DateFilter]]` (OR-of-ANDs) with comparison operators, compiled into Cypher predicates on `e.valid_at` etc. (https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py).
- **Contradiction detection exists**: "The system employs an LLM to compare new edges against semantically related existing edges to identify potential contradictions. When the system identifies temporally overlapping contradictions, it invalidates the affected edges by setting their [`invalid_at`] to the [`valid_at`] of the invalidating edge… Graphiti consistently prioritizes new information when determining edge invalidation." Deduplication is constrained to edges between the same entity pair.
- DMR: Zep **94.8%** (gpt-4-turbo) and **98.2%** (gpt-4o-mini), vs MemGPT 93.4%, full-conversation **94.4%**/**98.0%**, session summaries 78.6%/88.0%, recursive summarisation 35.3%.
- LongMemEval: Zep gpt-4o **71.2%** vs full-context **60.2%**; latency **2.58 s** vs **28.9 s**; **1.6k** vs **115k** avg context tokens. gpt-4o-mini: Zep 63.8% vs full-context 55.4%.
- Per-category LongMemEval (Table 3 of the paper) is where it gets interesting — see "Where it breaks".

### Mem0 — extract/consolidate/retrieve, plus a graph variant
- arXiv:2504.19413 — https://arxiv.org/abs/2504.19413
- Two-phase: extraction (LLM proposes candidate facts from a rolling summary + recent messages) then an update operator that classifies each candidate as ADD/UPDATE/DELETE/NOOP against retrieved similar memories. `Mem0^g` adds an entity-relationship graph layer.
- LOCOMO, LLM-as-Judge (J), 10 runs, ±1 s.d. (Table 1):
  - Mem0: single-hop **67.13 ± 0.65**, multi-hop **51.15 ± 0.31**, open-domain **72.93 ± 0.11**, temporal **55.51 ± 0.34**
  - Mem0^g: **65.71 ± 0.45**, **47.19 ± 0.67**, **75.71 ± 0.21**, **58.13 ± 0.44**
  - Zep (as configured by Mem0): **61.70**, **41.35**, **76.60**, **49.31**
  - OpenAI memory: **63.79**, **42.92**, **62.29**, **21.71**
  - LangMem: **62.23**, **47.92**, **71.12**, **23.43**
  - A-Mem* (Mem0's re-run at temp 0): **39.79**, **18.85**, **54.05**, **49.91**
- Headline claims: "26% relative improvements in the LLM-as-a-Judge metric over OpenAI", "**91% lower p95 latency**", ">90% token cost" saved.
- Mem0 is also the only system in this literature that reports **10 independent seeds with standard deviations**. That is the high-water mark of statistical practice in the field, which is itself the finding.

### A-MEM — Zettelkasten-style agentic memory
- arXiv:2502.12110 — https://arxiv.org/abs/2502.12110 ; code https://github.com/agiresearch/A-mem
- Each memory is an atomic "note" with timestamp, content, LLM-generated contextual description, keywords, tags, embedding. Two mechanisms: **link generation** (retrieve nearest historical notes, LLM decides whether to create bidirectional links) and **memory evolution** (retrieved neighbours may have their own context/tags rewritten when a new note arrives).
- LOCOMO F1 / BLEU-1, GPT-4o-mini (its own Table): single-hop **27.02 / 20.09**, multi-hop **45.85 / 36.67**, temporal **12.14 / 12.00**, open-domain **44.65 / 37.06**, adversarial **50.03 / 49.47**; avg token length **2,520** vs LoCoMo baseline 16,910 and MemGPT 16,977.
- Ablation: without link generation and memory evolution, single-hop F1 collapses **27.02 → 9.65**; without memory evolution only, **27.02 → 21.35**. So the linking, not the note structure, is load-bearing.

### HippoRAG and HippoRAG 2 — hippocampal indexing, PPR over an OpenIE graph
- HippoRAG (NeurIPS'24): https://openreview.net/forum?id=hkujvAPVsg
- HippoRAG 2 = "From RAG to Memory: Non-Parametric Continual Learning for LLMs", arXiv:2502.14802 — https://arxiv.org/abs/2502.14802 ; code https://github.com/OSU-NLP-Group/HippoRAG
- Mechanism: OpenIE triples → phrase nodes + passage nodes + synonym edges + context edges; queries are linked to triples, then Personalized PageRank spreads activation. Neocortex = LLM/embedder, hippocampal index = the KG, PPR = pattern completion.
- QA F1 avg over 7 datasets (Table 2): HippoRAG 2 **59.8**, NV-Embed-v2 (7B) **57.0**, GritLM-7B **56.1**, GTE-Qwen2-7B **54.9**, HippoRAG **53.1**, GraphRAG **49.6**, RAPTOR **48.8**, BM25 **47.7**, no-retrieval **38.4**, **LightRAG 6.6**.
- Passage recall@5 avg (Table 3): HippoRAG 2 **78.2** vs NV-Embed-v2 **73.4**, GritLM **72.2**, GTE-Qwen2 **70.5**.
- Cost table: HippoRAG 2 **9.2M input tokens, 3.0M output, 99.5 min indexing, 1.2 s/query, 9.9 GB GPU** vs NV-Embed-v2 **12.1 min (12.3%), 0.3 s/query, 1.7 GB**; GraphRAG **115.5M input tokens (1255.4%), 277 min (278.4%)**; LightRAG **68.5M (744.6%)**.
- No temporality, no validity, no provenance obligation. It is a retrieval index, marketed as "long-term memory".

### MemoryBank — the Ebbinghaus forgetting curve
- arXiv:2305.10250 — https://arxiv.org/abs/2305.10250
- Hierarchical event summaries + user portrait, with an explicit retention function derived from the Ebbinghaus curve: retention decays with elapsed time and is reset/strengthened on recall. LongMemEval's survey table classifies it as one of the few "Time-aware: Yes" designs (https://arxiv.org/abs/2410.10813).
- LOCOMO F1 (as re-run by A-MEM and by Mem0): single-hop **5.00**, multi-hop **5.56**, temporal **9.68**, open-domain **6.61** — the **worst** of every system tested in both papers. The only architecture in the corpus with a principled decay law is also the worst-scoring on the field's flagship benchmark. That fact is doing a lot of quiet damage to the field's incentive to work on forgetting.

### MemoryOS — OS-style tiering
- arXiv:2506.06326 (EMNLP 2025) — https://arxiv.org/abs/2506.06326 ; code https://github.com/BAI-LAB/MemoryOS
- Short-term / mid-term / long-term personal memory, with four modules (Storage, Updating, Retrieval, Generation). Short→mid is a dialogue-chain FIFO; mid→long uses a segmented page organisation with heat-based promotion.
- Reported: "average improvement of **49.11%** on F1 and **46.18%** on BLEU-1 over the baselines on GPT-4o-mini" on LoCoMo (relative improvement, not absolute score), and **+3.2%** accuracy over A-Mem on GVD.

### MIRIX — six typed memories + multi-agent control
- arXiv:2507.07957 — https://arxiv.org/abs/2507.07957
- Six memory types: Core, Episodic, Semantic, Procedural, Resource, **Knowledge Vault**; a Meta Memory Manager routes writes/reads to six specialised agents. Multimodal (screenshots).
- ScreenshotVQA (~20,000 high-res screenshots per sequence): **35% higher accuracy than the RAG baseline with 99.9% lower storage**. LOCOMO: **85.38%** overall, quoted against **Mem0 66.88%** and **Zep 75.14%**.

### Memp — procedural memory with an explicit deprecation step
- arXiv:2508.06433 — https://arxiv.org/abs/2508.06433 ; code https://github.com/zjunlp/MemP
- Distils trajectories into both step-level instructions and script-like abstractions, and treats Build/Retrieve/**Update** as separate design axes with "a dynamic regimen that continuously updates, corrects, and **deprecates** its contents". Evaluated on TravelPlanner and ALFWorld; procedural memory built by a strong model transfers usefully to a weaker model.
- Notable as one of very few papers that treats *deprecation of a stored item* as a first-class operation rather than an afterthought.

### Titans — memory at inference time (Google)
- arXiv:2501.00663, NeurIPS 2025 — https://arxiv.org/abs/2501.00663
- A deep neural long-term memory module whose weights are updated during the forward pass by gradient of an associative-memory loss ("surprise"), with momentum and **weight decay acting as an explicit forgetting gate**. Three variants: Memory as Context (MAC), Gated (MAG), Layer (MAL).
- Scales past **2M tokens**; Titans (MAC) reported to outperform baselines including GPT-4 on BABILong — note this is presented as **Figure 6, not a table**, so exact per-length percentages are not extractable from the HTML.
- Its most useful sentence for us is the diagnosis of the competition: Mamba2 "is not capable of removing a memory", and DeltaNet, "although it is capable of removing memory using delta rule… cannot erase the memory, lacking forgetting mechanism."
- Relevance caveat: Titans is a *parametric* memory. It has no ids, no provenance, no auditability, and cannot answer "what did we believe on Aug 19". It is orthogonal to our problem, not competition.

### Eywa — provenance-grounded memory, "evidence before belief"
- arXiv:2605.30771 — https://arxiv.org/abs/2605.30771 ; artifacts https://eywa.to/research
- The closest published relative of our intended design. Two-tier write path: **Tier 0 immutable capture** of raw evidence, **Tier 1 validated extraction** where a candidate belief is committed only if `V = V_support ∧ V_hard ∧ V_subject ∧ V_act` — i.e. LLM-derived claims are checked against deterministic typed signals (dates, entities, anchors) and must match hard values (dates, versions, amounts, URLs, names) exactly against source text.
- Object model with declared mutability: Evidence **immutable**; Signals **append-only**; Candidates transient; **Beliefs revisable**; Links (provenance edges) **append-only**.
- **Read path contains zero LLM calls**: a deterministic query planner picks weights across four routes (vector / keyword / entity / graph / temporal), RRF-fuses, applies scope and validity filters, then packs to a token budget. Observed latency: hot vector 1–3 ms, interactive retrieval **198–200 ms**.
- Numbers: LoCoMo C1–C4 **90.19% (1,389/1,540)** with Sonnet 4.6 write+QA and GPT-4o judge; GPT-4o **88.77%**; Kimi K2.5 **84.09%**. LongMemEval-S **88.2%** overall (knowledge-update **96.2%** on 78 questions; single-session-assistant **73.2%** on 56). BEAM 700 questions: **81.45%** mean nugget, pass@0.5 **597/700 (85.29%)** — with **knowledge update the second-worst category at 70.00% mean, pass@0.5 49/70**, and contradiction resolution **93.21%**.
- Model-separation ablation is the single most useful experiment in the paper: Qwen3-32B writing *and* answering scores **69.09%**; Qwen3-32B answering over **Sonnet-written memory** scores **79.68%**. **+10.6 points from write-path quality alone**, with the read model held fixed.
- Its own survey table (Table 19) scores provenance across the field: Mem0 `n.s.`, Mem0^g `n.s.`, Supermemory `partial`, Zep/Graphiti `graph-linked` + `bi-temporal`, A-MEM `note-linked`, MemoryOS `n.s.`, MemGPT `n.s.`, Eywa `evidence-linked` + `temporal metadata`.

### TEPA — revocable evidence memory; the first paper to prove stale memory is net-negative
- arXiv:2608.07429 (7 Aug 2026) — https://arxiv.org/abs/2608.07429
- Names the failure mode **memory pollution**: "degradation caused by active memories that newer conflicting evidence has superseded". Represents observations as **keyed precedents** `p = (k, v, s, f, σ, τ)` where `κ(x)` is a conflict key and `ν(x)` the asserted value; `conflict(x_i, x_j) = 1[κ(x_i)=κ(x_j) ∧ ν(x_i)≠ν(x_j)]`. Lifecycle state `σ ∈ {Hypothesis, Active, Revoked}` governed by a Beta-Bernoulli posterior `q(p)`; thresholds: propose at 3 supports, revoke below **0.3**, promote above **0.6**, Beta(1,1) prior.
- **Revoked precedents are archived, not deleted** — "preserving revoked history for audit… and later re-promotion". This is assert-time bitemporality arrived at from the drift-detection direction rather than the database direction.
- Defines a **Memory Pollution Index**: `MPI_{m,φ} = (S_NoMem,φ − S_m,φ) / S_NoMem,φ`.
- Full-reversal success rate, 50 seeds (Table 7): controlled drift — append-only **0.210**, last-write-wins **0.210**, **no memory 0.309**, TEPA **0.950**. Real file-backed executable drift — **0.203 / 0.203 / 0.298 / 0.950**. Preference-update stream — append **0.138**, no memory **0.837**, TEPA-Full **0.872**.
- Paired significance (Table 9): TEPA vs append-only in reversal phases **+0.740, 95% CI [0.722, 0.756], corrected p<0.001**; and **no memory vs append-only in reversal +0.098, CI [0.085, 0.112], p<0.001**.
- Key-noise audit (Table 6): TEPA **0.950 / 0.908 / 0.886 / 0.777** at 0 / 5 / 10 / 20% structured key corruption; reactive forgetting 0.796 → 0.613; last-write-wins and append-only stay flat at ~0.21 because they have no lifecycle signal at all.
- Scalability (Table 14): at 1M updates, per-query latency append-scan **4006.250 ms** vs last-write-wins **0.399 ms** vs TEPA lifecycle **0.301 ms**.

### The forgetting / consolidation line
- **MaRS + FiFA**, arXiv:2512.12856 — https://arxiv.org/abs/2512.12856 — "forgetting-by-design"; episodic/semantic/social/task memories as **typed, provenance-tracked nodes**; six formalised policies (FIFO, LRU, Priority Decay, Reflection-Summary, Random-Drop, Hybrid) with complexity analyses and optional **(ε,δ)-differential privacy**; 300 evaluation runs; hybrid policy composite score **0.911**.
- **Titans** (above) is the parametric-side analogue: decay as an explicit gate.
- **MemoryBank** (above) is the Ebbinghaus-curve ancestor.
- Survey coverage of the taxonomy (LFU/LRU/time-decay/importance-driven, RL-learned store/update/discard) is in arXiv:2603.07670 — https://arxiv.org/abs/2603.07670.

### The conflict / knowledge-conflict line
- **Knowledge Conflicts for LLMs: A Survey**, arXiv:2403.08319 (EMNLP 2024) — https://arxiv.org/abs/2403.08319 — the canonical taxonomy: **context-memory**, **inter-context**, **intra-memory** conflict. Our "two live records asserting different values for the same metric" is *inter-context* conflict inside a store, which the survey covers least.
- **Graphiti edge invalidation** (above) — LLM-detected, newest-wins, no human in the loop, no confidence.
- **TEPA** (above) — key-based structural conflict detection with a posterior, not an LLM judgement.
- **StateAuditor**, arXiv:2608.01619 — https://arxiv.org/abs/2608.01619 — the sharpest statement of the right split: "An LLM proposes candidate old-to-new transitions from timestamped evidence; deterministic code pins each quotation to a single entry, checks that the new evidence really is newer, and lets only these verified transitions trigger repair. **What is verified is provenance and chronology — not semantic supersession.**"

### The security / governance line — where "mandatory provenance" actually lives
- **A Survey on Long-Term Memory Security in LLM Agents: Toward Mnemonic Sovereignty**, arXiv:2604.16548 — https://arxiv.org/abs/2604.16548
- Nine architectural primitives: **P1** memory unit abstraction, **P2 write gate** (pre-consolidation validation hook), **P3** provenance metadata at write time, **P4** versioning/snapshots/diffs, **P5** trust/sensitivity labels, **P6** principal scoping, **P7** rollback, **P8** deletion semantics, **P9** internal-channel observability.
- Comparison matrix (Table 12; ✓ explicit, ⚫ partial, ✗ absent):

  | Architecture | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 |
  |---|---|---|---|---|---|---|---|---|---|
  | MemGPT | ✓ | ⚫ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | MemoryBank | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⚫ | ✗ |
  | Mem0 | ✓ | ⚫ | ⚫ | ✗ | ✗ | ⚫ | ✗ | ⚫ | ✗ |
  | MemOS | ✓ | ⚫ | ✓ | ✓ | ✓ | ✓ | ⚫ | ⚫ | ⚫ |
  | Collaborative Memory | ✓ | ⚫ | ✓ | ⚫ | ⚫ | ✓ | ⚫ | ⚫ | ⚫ |
  | CoALA | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ⚫ |

- Verbatim: "**no published memory architecture covers all nine governance primitives we identify; write-gate validation and post-deletion verification are shared blind spots across every system examined**" and "P2 (Write Gate) and P8 (Deletion Semantics) are shared blind spots across all six — no published a[rchitecture]…".
- Status of the forgetting-enabling primitives (Table 8): cross-substrate deletion orchestration "**Not yet demonstrated end-to-end**"; post-deletion verification "**Open research problem**"; lineage tracking through compression/reflection "**Rare in published architectures**"; content-addressable snapshots/diffs "Rare; closest published analog is MemCube versioning".
- Recommends **W3C PROV Data Model** (Moreau et al. 2013) as the serialisation for P3–P9: "An implementation that treats PROV as its metadata serialization thus starts from an interoperable baseline rather than a bespoke schema".
- Threat that makes the write gate non-optional: **MINJA**, arXiv:2503.03704 — https://arxiv.org/abs/2503.03704 — injects malicious records into an agent's memory bank **by query-only interaction**, no direct store access. Reported >95% injection success and >70% attack success across EHRAgent/RAP/MMLU settings.

---

## Evaluation: what the benchmarks actually measure

### LOCOMO
- arXiv:2402.17753 (ACL 2024) — https://arxiv.org/abs/2402.17753 — 10 machine-generated-then-human-edited conversations, 19–32 sessions, ~16k–26k tokens each, 7,512 QA pairs (1,986 in the graded set, **1,540 non-adversarial**).
- **LongMemEval's own comparison table marks LOCOMO as ✗ on Knowledge Update (KU)** and gives its context depth as 10k (https://arxiv.org/abs/2410.10813). The field's flagship "memory" benchmark does not test whether memory gets *corrected*.

### LongMemEval
- arXiv:2410.10813 — https://arxiv.org/abs/2410.10813 — 500 questions, five abilities (information extraction, multi-session reasoning, **knowledge update**, temporal reasoning, abstention), `LongMemEval_S` ≈115k tokens, `LongMemEval_M` ≈1.5M. Human validation of the dataset itself: **0.98** average correctness across question types.
- Commercial assistants (Table 1): oracle "Offline Reading" GPT-4o **0.9184**; **ChatGPT GPT-4o 0.5773**, ChatGPT GPT-4o-mini 0.7113, **Coze GPT-4o 0.3299**, Coze GPT-3.5-turbo 0.2474.
- Per-ability for commercial systems (Table 8): ChatGPT GPT-4o **KU 0.833, TR 0.435**; ChatGPT GPT-4o-mini KU 0.667, TR 0.652; **Coze GPT-4o KU 0.208, TR 0.391**; **Coze GPT-3.5-turbo TR 0.043**.
- Oracle → full-context degradation (Table 2): GPT-4o **0.870 → 0.606 (−30.3%)**; Llama-3.1-70B **0.744 → 0.334 (−55.1%)**; with Chain-of-Note, Llama-3.1-70B **0.848 → 0.286 (−66.3%)**.
- Design finding we should copy: keys built as **value + extracted fact** beat value-only keys on every configuration (session-value recall@10 **0.862** vs **0.783**), while **keyphrase keys are much worse** (0.576–0.768). Round-level granularity is consistently worse than session-level.

### MemoryAgentBench — the only benchmark that isolates conflict resolution, and the most damning table in the literature
- arXiv:2507.05257 (ICLR 2026) — https://arxiv.org/abs/2507.05257 ; code https://github.com/HUST-AI-HYZ/MemoryAgentBench
- Four competencies: Accurate Retrieval, Test-Time Learning, Long-Range Understanding, **Conflict Resolution**. CR is measured by **FactConsolidation**, built from MQuAKE counterfactual edit pairs: each pair is a true fact and a contradicting rewrite, ordered so the rewrite arrives later; concatenated to 32K/64K/262K contexts. Agents are explicitly told to prefer later information.
- FactConsolidation at 262K, single-hop (SH) / multi-hop (MH), substring-EM:

  | System | SH | MH |
  |---|---|---|
  | GPT-4o (long context) | **60.0** | 5.0 |
  | BM25 | 56.0 | 3.0 |
  | NV-Embed-v2 | 55.0 | 6.0 |
  | HippoRAG-v2 | 54.0 | 5.0 |
  | GPT-4o-mini | 45.0 | 5.0 |
  | Claude-3.7-Sonnet | 43.0 | 2.0 (**0.0** at 262K, Table 10) |
  | GPT-4.1-mini | 36.0 | 5.0 |
  | Gemini-2.0-Flash | 30.0 | 3.0 |
  | Cognee | 28.0 | 3.0 |
  | MemGPT | 28.0 | 3.0 |
  | Self-RAG | 19.0 | 3.0 |
  | **Mem0** | **18.0** | 2.0 |
  | GraphRAG | 14.0 | 2.0 |
  | RAPTOR | 14.0 | 1.0 |
  | Contriever | 18.0 | **7.0** (best MH anywhere) |

- **The best multi-hop conflict-resolution score across every system tested is 7.0%.** BM25 — a 1994 lexical retriever — beats every purpose-built agentic memory system on single-hop conflict resolution.
- Mem0's test-time-learning row is worth recording separately: BANKING77 **5.0**, CLINC150 **4.0**, NLU **1.0**, TREC-Fine **1.0**, ∞Bench-Sum **0.8**.

### HaluMem — the only operation-level benchmark, and the source of the real staleness numbers
- arXiv:2511.03506 — https://arxiv.org/abs/2511.03506 ; code https://github.com/MemTensor/HaluMem
- Evaluates **memory extraction, memory updating, and memory QA separately, after each session**, rather than end-to-end. 14,948 target memories incl. **3,122 update memories** and 2,648 distractors; 3,467 questions incl. **769 memory-conflict** and 180 dynamic-update. HaluMem-Medium avg **159,910.95** tokens/user; HaluMem-Long avg **1,007,264.65**.
- "Memory Accuracy (Anti-Hallucination)… evaluates whether the extracted memories are factual and free from hallucination"; scored 2 = fully supported, 1 = partially supported with unsupported/contradictory content, 0 = "entirely unsupported or contradictory (a 'hallucinated memory')".
- HaluMem-Medium: Mem0 memory recall **42.91%**, weighted recall 65.03%, target precision 86.26% (10,556), **Memory Accuracy 60.86% of 16,291 extracted memories**, false-memory resistance **56.80%**, **memory-update correct 25.50%, omitted 74.02%**, QA correct 53.02%, **QA hallucination 19.17%**. Memobase: accuracy **32.29% of 17,081**, update correct **5.20%**, omitted **94.25%**. Supermemory: accuracy 60.83% of 22,551, update correct 16.37%, omitted 82.47%.
- HaluMem-Long (≈1M tokens/user): **Mem0 recall 3.23%, accuracy 46.01%, update correct 1.45%, update omitted 98.51%**; Mem0-Graph recall **2.24%**, accuracy 41.26%, update correct **1.47%**, omitted **98.40%**; Supermemory accuracy **29.71% of 77,134**, update correct 17.01%.
- Efficiency: Mem0 spends **2,768.14 minutes (≈46 h)** on the add-dialogue phase of HaluMem-Medium alone.
- **This is the answer to question (d)**, and it is worse than anyone advertises: roughly **39% of what Mem0 writes on Medium and 54% on Long is unsupported or contradictory**, and at 1M-token scale it correctly applies **1.45%** of required updates.

### STALE — the only benchmark aimed directly at "is this memory still true?"
- https://tandemly.ai/research/stale-agent-memory-validity (2026-05-15; synthesis of Chao, Bai et al. 2026)
- 1,200 queries across three axes: **state resolution** (does the agent notice a stored belief is outdated?), **premise resistance** (does it refuse a question that presupposes the stale state?), **implicit policy adaptation** (does it proactively change behaviour when context implies the policy no longer holds?). Each axis splits explicit vs **implicit** conflict.
- **Best frontier model: 55.2%** across the full benchmark. Failures cluster on implicit conflict; IPA is the lowest axis. "Detection and refusal are not the same skill — an agent can correctly register that a belief is outdated and still answer as though it were current."
- Follow-on: **StateAuditor**, arXiv:2608.01619 — https://arxiv.org/abs/2608.01619 — attacks the IPA gap by auditing *from stored state to draft* instead of draft-to-state, because "in an open-ended response the stale dependency is usually unsaid."

### PrecisionMemBench — memory benchmarks don't measure precision
- arXiv:2605.11325 — https://arxiv.org/abs/2605.11325
- "Current LLM memory benchmarks evaluate answer quality rather than retrieval accuracy. Consequently, **a system that dumps its entire belief store can achieve perfect recall and mask severe precision failures**." 89 cases measuring precision, noise isolation, session latency, belief mutability. Across 13 configurations, baselines "fail to reach even half of the active passes, with **precision scores clustering at 0.22 and below**".
- Their fix — `Tenure` — "resolves scope and retrieval before inference and injects typed belief state as **ambient instruction** before the model sees the prompt, **removing model-side discretion over whether memory is consulted**".

### Reclaim evaluation — a lossy memory is worse than an empty one
- arXiv:2606.25449 — https://arxiv.org/abs/2606.25449
- "A memory that keeps a wrong conclusion but drops the work behind it leads a model to re-emit the stale value as a confident answer, where an empty memory leads it to abstain." The measured discriminator is **whether the memory retained a re-derivation basis (the source)** rather than the answer. Protocol: induce known drift, compress at fixed budget, deliver a correction naming the error, score exact recovery, judge-free.

### BEAM, LoCoMo-Plus, MemoryBench, AMemGym, MEMTRACK — the 2025-26 correction wave
- **BEAM** (arXiv:2510.27246, ICLR 2026 — https://arxiv.org/abs/2510.27246): 100 conversations, **2,000 validated questions**, scales **128K / 500K / 1M / 10M** tokens, ten memory abilities. "Even LLMs with 1M token context windows (with and without retrieval-augmentation) struggle as dialogues lengthen." Their LIGHT framework gains **3.50%–12.69%** over the strongest baselines.
- **LoCoMo-Plus** (arXiv:2602.10715 — https://arxiv.org/abs/2602.10715): tests "cognitive memory under cue–trigger semantic disconnect", i.e. latent constraints never explicitly queried, and shows "conventional string-matching metrics and explicit task-type prompting are misaligned with such scenarios".
- **MemoryBench (Tsinghua)** (arXiv:2510.17281 — https://arxiv.org/abs/2510.17281): 20,000 cases, 11 datasets, 3 domains, 4 task formats, 2 languages, with user-feedback simulation. Headline: **"none of the advanced memory-based LLMsys (i.e., A-Mem, Mem0, or MemoryOS) can consistently outperform RAG baselines that simply use all task context and feedback logs as retrieval corpus"**, and prior LoCoMo wins "do not generalise" outside reading comprehension.
- **AMemGym** (arXiv:2603.01966, ICLR 2026 — https://arxiv.org/abs/2603.01966): on-policy interactive evaluation; "off-policy evaluation introduces **reuse bias**, undermining memory optimization and configuration selection". Off-policy rankings disagree with on-policy rankings by **up to three positions**; best agentic-write config **0.291 on-policy vs 0.253 off-policy**.
- **MEMTRACK** (arXiv:2510.01353, NeurIPS 2025 SEA Workshop — https://arxiv.org/abs/2510.01353): Slack + Linear + Git interleaved timelines with "noisy, conflicting, cross-referring information". Best model, **GPT-5, achieves only 60% Correctness**. This is the closest published analogue to our actual deployment shape (multi-project, multi-tool, event-driven) and the ceiling is 60%.

### The benchmark-integrity scandal
- **Dell Zhang, "The Benchmark Theatre"** (2026-05-20) — https://essays.bloo-mind.ai/posts/2026-05-20-mem-eval/ — the best single synthesis; all figures below are from it with the primary source named.
- **Penfield Labs LoCoMo audit**: **99 score-corrupting errors in 1,540 questions = 6.4%**, so the theoretical ceiling on published LoCoMo is **~93.6%** — meaning EverMemOS's claimed 95.96% single-hop / 91.37% multi-hop is arithmetically impossible. Audit repo `dial481/locomo-audit`; write-up https://www.reddit.com/r/MachineLearning/comments/1s54cvg/d_we_audited_locomo_64_of_the_answer_key_is_wrong/. Example errors: the answer key says "Ferrari 488 GTB" when the conversation contains only "this beauty" plus an image caption "a red sports car" — the model name exists only in the annotator's internal search-string field that no memory system ingests; 24 questions attribute statements to the wrong speaker; a "Last Saturday" question resolves to Sunday in the key.
- **The judge is broken**: the standard LoCoMo judge (GPT-4o-mini, original prompt, which instructs it to be "generous") **accepted 62.81% of intentionally wrong-but-topical answers** across all 1,540 questions. Wrong-name/wrong-date errors caught ~89%; vague-but-topical answers passed nearly two-thirds of the time — *which is precisely the signature of weak retrieval*.
- **LoCoMo-Refined** (https://github.com/mem-eval-suite/LoCoMo_refined): refined judge (Qwen3-14B) achieves **86.33% agreement with humans on 300 manually annotated samples vs 43.67% for the original LoCoMo setup**; 337 problematic samples cleaned, 1,382 questions released.
- **The vendor fight**: Mem0's paper reports Zep at **65.99%**; Zep's blog "Lies, Damn Lies, & Statistics" originally claimed **84%** (https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/); Mem0's CTO documented that Zep had included Category 5 in the numerator while excluding it from the denominator, inflating by ~25 points, and re-ran at **58.44% ± 0.20** over 10 seeds (https://github.com/getzep/zep-papers/issues/5); Zep then published the correction verbatim: "**we erred in how we calculated Zep's LoCoMo score… Zep's corrected result is 75.14% +/- 0.17**". Same benchmark, same system, three numbers: **58.44 / 65.99 / 75.14**.
- **Letta: a filesystem and `grep` beats all of them.** https://www.letta.com/blog/benchmarking-ai-agent-memory/ (2025-08-12): a Letta agent on **GPT-4o-mini** with the conversation stored in a plain file and tools `search_files`, `grep`, `answer_question` scores **74.0% on LoCoMo**, "significantly above Mem0's reported 68.5% score for their top-performing graph variant". Letta's own conclusion: "current memory benchmarks may not be very meaningful" and "memory is more about how agents manage context than the exact retrieval mechanism used."
- **Full-context beats the memory systems**: Mem0's own paper shows a full-context baseline around **73%**, above Mem0's best of ~68%. Zep's DMR table shows full-conversation **98.0%** vs Zep **98.2%** on gpt-4o-mini — a 0.2-point "win".
- **Reproducibility**: EverMemOS claims **92.32%**, third-party reproduction on issue #73 reports **38.38%**. Vendors respond that "the web API version has more optimisations" not in the open-source release.
- **Statistics**: **56% of adjacent-pair comparisons across published systems are statistically indistinguishable** under Wilson-score 95% CIs; the Open-Domain category (n=96) requires a **15-point gap** to separate any two systems. Only Mem0 publishes multi-seed numbers.
- **Reproduction gap inside a single paper**: Mem0 re-ran A-MEM at temperature 0 and got single-hop F1 **20.76** vs A-MEM's published **27.02**, and open-domain **33.34** vs **44.65** — a 6–11 point gap on the same benchmark (https://arxiv.org/abs/2504.19413 vs https://arxiv.org/abs/2502.12110).

---

## What is proven vs claimed

**Proven (replicated, or with intervals, or by an adversarial third party):**
1. Multi-signal retrieval scoring (recency + importance + relevance) beats pure cosine similarity. Component-wise ablation, d=8.16 — https://arxiv.org/abs/2304.03442.
2. Structured memory massively reduces tokens and latency vs full-context replay. Zep 1.6k vs 115k tokens, 2.58 s vs 28.9 s (https://arxiv.org/abs/2501.13956); Mem0 91% lower p95 (https://arxiv.org/abs/2504.19413); Eywa 198–200 ms zero-LLM reads (https://arxiv.org/abs/2605.30771); TEPA 0.301 ms vs 4006 ms append-scan at 1M updates (https://arxiv.org/abs/2608.07429). **This is the one claim the whole field agrees on and that nobody has refuted.**
3. **Append-only-without-invalidation memory is worse than no memory under drift.** 50 seeds, paired tests, p<0.001, two independent task families — https://arxiv.org/abs/2608.07429.
4. **Conflict resolution is unsolved.** Best multi-hop score 7.0% across 19 systems, independent third-party harness — https://arxiv.org/abs/2507.05257.
5. **Memory systems write a lot of wrong facts.** Operation-level measurement, four commercial systems — https://arxiv.org/abs/2511.03506.
6. **Write-path quality dominates read-path quality.** +10.6 points from swapping only the writing model — https://arxiv.org/abs/2605.30771.
7. **Bitemporality is implementable and shipped.** Four timestamps and as-of date filters verified in Graphiti source, not just the paper.
8. LOCOMO's answer key is 6.4% wrong and its judge accepts 62.81% of wrong-but-topical answers — open, SHA256-verified audit repo.

**Claimed but not established:**
1. Every "SOTA on LoCoMo" number, without exception. The same system spans 38.38%–92.32% depending on who runs it; a `grep` baseline gets 74.0%; full-context gets ~73%; the answer-key ceiling is ~93.6%.
2. That graph structure buys accuracy. HippoRAG 2 is **+2.8 F1 avg** over NV-Embed-v2 for **8× the indexing time** and loses to GTE-Qwen2 on PopQA; GraphRAG costs 1255% of the input tokens for a *lower* score than a plain embedder; LightRAG scores **6.6**. On MemoryAgentBench, GraphRAG scores 14.0/2.0 on conflict resolution and **0.4** on summarisation.
3. That published wins generalise. "None of the advanced memory-based LLMsys can consistently outperform RAG baselines that simply use all task context" — https://arxiv.org/abs/2510.17281. Off-policy rankings move by up to three positions when made on-policy — https://arxiv.org/abs/2603.01966.
4. MemoryOS's "49.11% improvement on F1" — a relative delta over unnamed baselines, absolute score not comparable to anything else in the field.
5. MIRIX's 85.38% LOCOMO — single-run, self-administered, and quotes competitors' most favourable/unfavourable numbers selectively (Zep at 75.14%, Mem0 at 66.88%).
6. Titans' BABILong superiority over GPT-4 — reported as a figure, not a table; no extractable per-length numbers.
7. Every claim about "provenance" in commercial memory products. Eywa's audit marks Mem0, MemoryOS and MemGPT as `n.s.` on provenance; the security survey gives Mem0 ⚫ on P3 and ✗ on P4 (versioning) and P7 (rollback).

---

## Where it breaks / what it cannot do

1. **Bitemporality exists but nothing is built on it.** Graphiti has all four timestamps and as-of filters, yet the paper never evaluates a single as-of query: "While these connections are not directly examined in this paper's experiments, they will be explored in future work." There is no published benchmark of as-of retrieval accuracy in agent memory. Nobody has measured whether "what did we believe on Aug 19" actually works.

2. **Newest-wins is the universal conflict policy, and it is provably insufficient.** Graphiti: "Graphiti consistently prioritizes new information when determining edge invalidation." TEPA's last-write-wins baseline scores **0.210** on controlled reversal — identical to append-only and *below no memory at 0.309* — because LWW cannot tell a genuine correction from a noisy observation. Recency is not evidence.

3. **The one system with real bitemporal machinery does *worst* on the category that machinery exists for.** Zep's own LongMemEval table: on **knowledge-update**, Zep gpt-4o-mini scores **74.4% vs full-context 76.9%** — a loss. On single-session-assistant, **75.0% vs 81.8%** (gpt-4o-mini) and **80.4% vs 94.6%** (gpt-4o) — two more losses. A temporal knowledge graph with edge invalidation does not beat dumping the transcript into the prompt on the questions about facts changing.

4. **LLM-judged contradiction detection degrades exactly where it matters.** Graphiti uses an LLM to compare new edges against semantically-related existing edges. TEPA's key-noise audit shows what happens when the conflict signal is corrupted: **0.950 → 0.777 at 20% key noise**. And structured keys are the *easy* case — TEPA itself concedes it "assumes useful conflict keys can be extracted from evidence… and a harder problem for open-ended memories whose conflict relation is implicit."

5. **Multi-hop conflict is a wall, and every architecture hits it.** MemoryAgentBench MH: best score anywhere **7.0%**, Claude-3.7-Sonnet **0.0%** at 262K. TEPA, purpose-built for revocation, gets **0.040 on MH-6k and 0.000 on SH-262k** — and *append-only beats it 0.350 to 0.000* at 262K, because at that length the bottleneck stops being validity and becomes retrieval. Fact-level validity tracking does not compose across hops.

6. **Stale detection is at coin-flip.** STALE: best frontier model **55.2%** over 1,200 queries; implicit conflict is the dominant failure. Worse, detection ≠ action: an agent that *knows* the belief is stale still answers as if it were current (the IPA gap).

7. **Memory writes are ~40–55% garbage at scale, and updates essentially don't happen.** HaluMem-Long: Mem0 applies **1.45%** of required updates and omits **98.51%**; memory accuracy **46.01%**; integrity recall **3.23%**. Mem0-Graph is worse on recall (2.24%). Adding a graph did not help.

8. **Precision is unmeasured, so dumping everything scores well.** "A system that dumps its entire belief store can achieve perfect recall and mask severe precision failures"; baselines cluster at **precision ≤ 0.22**.

9. **The write gate does not exist anywhere.** P2 in the mnemonic-sovereignty matrix: MemGPT ⚫, MemoryBank ✗, Mem0 ⚫, MemOS ⚫, Collaborative Memory ⚫, CoALA ✗. Verbatim: "no published architecture reaches explicit support". MINJA exploits exactly this with query-only access at >95% injection success.

10. **Confidence does not exist as a field.** Verified in Graphiti source: `EntityEdge` has `name, fact, fact_embedding, episodes, expired_at, valid_at, invalid_at, reference_time, attributes` — no confidence, no evidence class, and `episodes` defaults to `[]`, so provenance is optional even in the best system. The mnemonic-sovereignty survey's P5 (trust/sensitivity labels) is ✗ for MemGPT, MemoryBank, Mem0 and CoALA.
    The one measured warning about confidence: "Confidence inflation… Poisoned confidence calibration: errors gain weight when written as high-priority lesson memory" (https://arxiv.org/abs/2604.16548). A confidence field that agents can set freely is an attack surface, not a safety feature.

11. **Immutability collides with deletion, and nobody has solved the collision.** Eywa's own design goal 7 requires "every evidence record… remain removable by user scope" — directly against its Tier-0 immutability. The survey: cross-substrate deletion "not yet demonstrated end-to-end", post-deletion verification "open research problem", and the framing tension is named explicitly — "retaining everything enlarges the attack surface; deleting everything undermines accountability."

12. **Extraction latency makes LLM-in-the-write-path unaffordable.** Mem0 spends **2,768 minutes** on the add-dialogue phase of HaluMem-Medium. GraphRAG burns 115.5M input tokens (1255%) to index. Any design that calls an LLM per write does not scale to hundreds of agents.

13. **The benchmarks cannot resolve what we care about.** LOCOMO doesn't score knowledge updates at all (✗ on KU in LongMemEval's own table), its key is 6.4% wrong, its judge accepts 62.81% of wrong answers, and its corpus fits in one prompt. LongMemEval-S is ~115k tokens — inside every frontier context window. Neither has an as-of query, a provenance requirement, or a contradiction object.

### The explicit verdict on (a)–(e)

| | Status | Best existing | The gap |
|---|---|---|---|
| **(a) bitemporality / as-of queries** | **Partially solved, never evaluated** | Graphiti/Zep: 4 timestamps + as-of date filters, verified in source (`edges.py`, `search_filters.py`); TEPA archives revoked precedents for audit | **Nobody has published a single as-of retrieval measurement.** No benchmark, no accuracy number, no latency number for "what did we believe on date D". Zep's paper explicitly defers it to future work. |
| **(b) provenance *required* on writes** | **NOBODY HAS SOLVED THIS** | Eywa validates extractions against typed signals before commit (`V_support ∧ V_hard ∧ V_subject ∧ V_act`); MaRS has "provenance-tracked nodes"; MemOS gets ✓ on P3 | **Server-side rejection of a write lacking provenance does not exist.** "No published architecture reaches explicit support" for P2, the write gate (https://arxiv.org/abs/2604.16548). Graphiti's `episodes` field defaults to `[]`. No system has a confidence *taxonomy* (measured / human-confirmed / derived / unverified) at all. |
| **(c) contradiction detection between stored facts** | **Detected, never adjudicated** | Graphiti (LLM compares new vs semantically-related edges, newest wins); TEPA (structural conflict key + Beta-Bernoulli posterior); knowledge-conflict survey taxonomy | **No system emits a first-class contradiction object requiring resolution.** Every published mechanism auto-resolves silently — by recency (Graphiti) or by posterior threshold (TEPA). Nothing escalates to a human, nothing blocks reads pending resolution, nothing survives as an auditable open question. And the measured ceiling is **7.0% on multi-hop** (https://arxiv.org/abs/2507.05257). |
| **(d) evidence on how much stored memory goes stale/wrong** | **Solved as measurement, ignored as a design input** | HaluMem (operation-level, 4 systems); TEPA's Memory Pollution Index; STALE (55.2%) | The numbers exist and are terrible — **39–54% of Mem0's writes unsupported or contradictory; 98.51% of required updates omitted at 1M tokens; append-only memory scores 0.210 where no memory scores 0.309**. **What nobody has** is a staleness measurement over a *real deployment* rather than a constructed benchmark, and no system exposes its own staleness rate as an observable metric. |
| **(e) forgetting / invalidation policies** | **Studied, not integrated** | MaRS/FiFA (six formalised policies, hybrid composite 0.911, optional (ε,δ)-DP); MemoryBank (Ebbinghaus); Titans (decay gate); Memp (explicit deprecation); TEPA (revoke + archive + re-promote) | **Cross-substrate deletion is "not yet demonstrated end-to-end" and post-deletion verification is an "open research problem"** (https://arxiv.org/abs/2604.16548, Table 8). Nothing propagates an invalidation through derived summaries, reflections, embeddings and projections. And the field's incentives are actively hostile: MemoryBank, the only classic system with a principled decay law, scores **worst** on LOCOMO. |

**Short version.** (b) is the true green field: mandatory, server-enforced, typed provenance on writes is a documented universal blind spot. (c) is half-open: detection exists, adjudication does not — nobody has a contradiction *object*. (a) is built but unmeasured, which is a marketing opportunity as much as an engineering one. (d) is measured and damning; use it as ammunition, not as a research target. (e) is the hardest unsolved piece, because invalidation must propagate through derived artefacts and nobody has demonstrated that.

---

## What we should steal

1. **Graphiti's exact four-timestamp schema.** `created_at` / `expired_at` (assert time) + `valid_at` / `invalid_at` (valid time), on the *fact*, not the node. It's shipped, it's open-source, and its search filters compile to real predicates. Do not reinvent the vocabulary — matching it makes us legible to anyone who has evaluated Zep. Source: https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py.

2. **TEPA's lifecycle state machine and its conflict-key formalism.** `σ ∈ {Hypothesis, Active, Revoked}`, `conflict(x_i,x_j) = 1[κ(x_i)=κ(x_j) ∧ ν(x_i)≠ν(x_j)]`, Beta-Bernoulli posterior with promote/revoke thresholds (0.6 / 0.3), and — critically — **revoked records archived for audit and eligible for re-promotion**. This is our supersession mechanism, already validated at p<0.001 with intervals. Our `metric_key` is TEPA's `κ`; our asserted value is `ν`. https://arxiv.org/abs/2608.07429.

3. **TEPA's Memory Pollution Index as our headline metric.** `MPI = (S_NoMem − S_m)/S_NoMem`. Shipping a memory product whose own docs prove it beats *no memory* under drift is a far stronger claim than any LoCoMo number, and it is a claim no competitor currently makes.

4. **Eywa's evidence/belief split with declared mutability.** Immutable evidence tier written before any derived belief; append-only provenance links; typed-signal validation with **hard anchors that must match source text exactly** (dates, versions, amounts, URLs, names — exactly our commits, instrument IDs and metric values). https://arxiv.org/abs/2605.30771.

5. **Eywa's zero-LLM deterministic read path.** A deterministic query planner over exact routes, RRF fusion, then validity/scope filters — 198–200 ms, no LLM in retrieval. This is precisely our "exact-first, embeddings as a labelled secondary channel", already benchmarked at 90.19% LoCoMo. Steal the shape and the latency budget.

6. **StateAuditor's separation of duties.** "An LLM proposes candidate old-to-new transitions from timestamped evidence; deterministic code pins each quotation to a single entry, checks that the new evidence really is newer… **What is verified is provenance and chronology — not semantic supersession.**" LLM proposes, deterministic code verifies. Never let an LLM be the sole authority for a supersession. https://arxiv.org/abs/2608.01619.

7. **Eywa's model-separation ablation as our standard experiment.** Hold the read model fixed, swap the write model, report the delta (+10.6 points). It isolates write-path quality — which is where the mnemonic-sovereignty survey says every architecture is blind — and it is cheap to run.

8. **Eywa's failure taxonomy as our error budget.** Coverage / grounding / revision / scope / temporal / retrieval / synthesis / **measurement** gaps. Reporting *which layer failed* rather than one aggregate score is the single strongest differentiator available, because the entire competitive set reports one number.

9. **LongMemEval's key-design result.** Keys = **value + extracted fact** beats value-only (recall@10 0.862 vs 0.783); keyphrase keys are much worse; session granularity beats round granularity. Free, measured index-design guidance. https://arxiv.org/abs/2410.10813.

10. **W3C PROV as the provenance serialisation.** The security survey explicitly recommends it: primitives P3–P9 are "with minor additions, expressible in the W3C PROV Data Model", giving "an interoperable baseline rather than a bespoke schema… the lightest-weight step we are aware of toward governance by construction". Free interop and free credibility for an enterprise sale.

11. **MaRS's typed forgetting policies with complexity analyses**, and its `(ε,δ)`-DP option, as the menu for scope-level retention configuration. https://arxiv.org/abs/2512.12856.

12. **MemoryAgentBench's FactConsolidation construction** — MQuAKE counterfactual edit pairs, ordered old-then-new, concatenated to a target length — as our internal regression harness for supersession. It is the only conflict test in the literature with an honest difficulty curve, and the multi-hop bar (7.0%) is so low that any real gain is publishable.

13. **Zep's community subgraph with label propagation instead of Leiden**, chosen "because label propagation's straightforward dynamic extension… enables the system to maintain accurate community representations for longer periods as new data enters the graph, delaying the need for complete community refreshes." If we ever need org-level rollups over a live graph, this is the right choice and the reasoning is already written down.

---

## What we should deliberately do differently, and why

1. **Provenance is a server-side admission-control gate, not metadata.** Every competitor treats provenance as an optional field (Graphiti's `episodes` defaults to `[]`; Mem0 scores ⚫ on P3 and ✗ on P4/P7). The survey says P2 has **no explicit support in any published architecture**, and MINJA achieves >95% injection with query-only access. Reject the write at the API boundary if evidence is absent or unresolvable. **This is our defensible technical claim and it is genuinely unoccupied.** Corollary: the confidence class must be *derived from the evidence type the server can verify*, never self-asserted by the writing agent — otherwise we have rebuilt the confidence-inflation attack the survey warns about.

2. **Emit a contradiction as a first-class durable object; never auto-resolve by recency.** Graphiti's newest-wins is measurably equivalent to append-only under reversal (0.210 vs 0.210, both below no-memory's 0.309). Our design must (i) keep both records live and flagged, (ii) refuse to return a single scalar for a contested key without surfacing the contradiction, (iii) require an explicit resolution assertion with its own provenance. TEPA's posterior is the right *prior* for auto-resolution when evidence classes are comparable; it is the wrong mechanism when a `measured` record conflicts with a `confirmed-by-human` one. **Evidence class, not timestamp, must dominate precedence.** No published system does this.

3. **Never let an LLM be the sole authority for extraction, conflict detection, or supersession.** HaluMem is the argument: 39–54% of LLM-extracted memories are unsupported or contradictory, and 98.51% of required updates are omitted at 1M tokens. Adopt StateAuditor's split — LLM proposes, deterministic code verifies chronology and pins each claim to exactly one evidence record — and Eywa's hard-anchor rule: numeric values, commits, dates and instrument IDs must match source text exactly or the write is rejected. A wrong number that carries a plausible citation is worse than no number.

4. **Ship as-of queries as a first-class, benchmarked API — not an unexercised schema.** Zep built the timestamps and never evaluated them; nobody in the literature reports as-of retrieval accuracy or latency. We should publish an as-of correctness benchmark (constructed the way FactConsolidation is, but scored on "what was believed at time T" rather than "what is true now"). This is a category we can define, and defining the benchmark is worth more than winning someone else's.

5. **Optimise for MPI and for stale-fact resistance, not for LoCoMo.** LoCoMo's key is 6.4% wrong, its judge accepts 62.81% of wrong-but-topical answers, its ceiling is ~93.6%, a `grep` baseline gets 74.0%, and full-context gets ~73%. **Report LoCoMo only with the LoCoMo-Refined judge, multi-seed, with the judge prompt published**, and lead with MPI, MemoryAgentBench FactConsolidation, STALE-style implicit-conflict axes, MEMTRACK (GPT-5 ceiling 60%) and BEAM at ≥1M tokens. Corollary: **we must beat full-context and `grep` on our own data by ≥10 points or we have no product.** Build both baselines into CI from day one.

6. **Do not build a graph as the primary substrate.** HippoRAG 2 buys **+2.8 F1** over a plain strong embedder for **8×** the indexing time and loses to GTE-Qwen2 on PopQA; GraphRAG burns 1255% of the input tokens for a lower average score; LightRAG scores 6.6; on MemoryAgentBench, GraphRAG gets 14.0/2.0 on conflict resolution and 0.4 on summarisation. Our scope hierarchy (global → project → mission → agent) is a *partition key and precedence order*, which is a relational/index problem. Add graph traversal only as one labelled retrieval route (as Eywa does, with a fixed weight) once exact-match retrieval is measurably insufficient.

7. **Keep LLM calls out of both the read path and the synchronous write path.** Eywa proves a zero-LLM read at 198–200 ms with 90.19% LoCoMo. Mem0 spends 46 hours on one benchmark's ingest. With hundreds of agents heartbeating and asserting, per-write LLM extraction is not an option — it is a cost and a latency failure and a 40%-error-rate failure simultaneously. Structured assertion from agents (typed payload + evidence) is the write API; LLM extraction is an optional, asynchronous, clearly-labelled `derived` path that produces `unverified` records.

8. **Design invalidation propagation before writing a single reflection or summary.** The survey: lineage tracking through compression/reflection is "rare in published architectures", cross-substrate deletion is "not yet demonstrated end-to-end", post-deletion verification is an "open research problem". Every derived artefact (summary, rollup, embedding, Linear issue, Discord message) must carry the ids it derives from, so a supersession invalidates its descendants transitively. Since our human tools are downstream projections driven by an event log, we get the propagation channel for free — **but only if we require derived-from ids on projections too.** Do this at schema-design time; it is unrecoverable later.

9. **Separate three retention tiers explicitly at design time: immutable audit log / operational memory / user-deletable content.** "Retaining everything enlarges the attack surface; deleting everything undermines accountability… Distinguish audit logs, operational memory, and user-deletable memory; avoid collapsing all state into a single tier" (https://arxiv.org/abs/2604.16548). "Append-only, nothing is ever deleted" is the right default for engineering facts and a compliance defect for anything containing personal data. Eywa hit this contradiction and papered over it. Decide the tier boundary now, and make `verified forgetting` (post-deletion membership tests) a shipped capability rather than a promise — the survey says nobody has one.

10. **Report per-layer diagnostics and precision, not one aggregate score.** PrecisionMemBench: "a system that dumps its entire belief store can achieve perfect recall and mask severe precision failures", baselines at precision ≤0.22. Publish precision, noise isolation, coverage/grounding/revision/scope/temporal/retrieval/synthesis attribution, **and our own measured staleness rate as a live metric**. In a field where 56% of published pairwise comparisons are statistically indistinguishable and the honest recommendation is "ignore the published number", per-layer diagnostics with intervals is the only credible differentiation left.

11. **Treat the "memory that keeps the answer but drops the derivation" failure as a hard schema rule.** "A memory that keeps a wrong conclusion but drops the work behind it leads a model to re-emit the stale value as a confident answer, where an empty memory leads it to abstain" (https://arxiv.org/abs/2606.25449). Our mandatory-evidence rule already implies this; make it explicit that a record whose evidence is unreachable is **not retrievable as a value** — it degrades to a contradiction/unverified state and the reader must abstain. Retrieval must never return a bare number, and it must also never return a number whose derivation basis has been garbage-collected.
