# The graph goes stale: what that costs, measured

Measured against the real Arc repository at `origin/master`, 966 indexed source files,
19,177 symbols, 102,450 edges. Every number below was produced by running something, and the
two bugs I hit producing them are recorded at the bottom because both would have shipped a
plausible wrong answer.

## 1. Churn: a full re-index repeats work it already did

| | |
|---|---|
| indexed source files | 965 |
| files a commit changes, median | **2** |
| mean / p90 / worst of 60 commits | 3.4 / 8 / 26 |
| cost of one full index | 46 MB, 3.7 s parse + 2.1 s load |

At 20 commits/day a naive one-index-per-commit scheme writes **27 GB/month**, which fills the
provisioned 10 GB volume in **11 days**.

## 2. Content addressing: 53.5x, measured not estimated

Over the last 60 commits of `master`, counting file-versions rather than commit-file pairs:

| storage model | entries |
|---|---|
| per commit x file | 57,623 |
| per distinct blob | **1,077** |
| ratio | **53.5x**, 98.1% saved |

The ratio improves with history, because it converges on "distinct file versions that ever
existed" rather than "commits times files". Deduped, the same 20 commits/day cost **0.50
GB/month** — 20 months on the volume already paid for, before any garbage collection.

## 3. How often does uncommitted work actually change the answer

32 commits, parsing each changed file at `c^` and at `c` and diffing symbol and edge sets:

| | |
|---|---|
| commits that changed the call graph | **88%** |
| commits that left it identical (body-only edits) | 12% |
| size of the change, when it changed | median **7 symbols, 24 edges** |

24 edges of 102,450 is 0.02% of the graph, so a stale answer is 99.98% right *about the
repository*. But those edges are the code being edited, and nobody asks "what breaks if I
change this" about a file they have not touched. The honest statement is: **correct about the
codebase, wrong about the question asked, 88% of the time.**

Blast radius, separately — the share of the graph reachable from an edited file, which bounds
what *could* move rather than what did:

| | median | p90 | worst |
|---|---|---|---|
| symbols in the edited files | 0.67% | 3.43% | 9.3% |
| one hop out | 17.1% | 30.8% | 42.9% |
| two hops out | 55.1% | 65.9% | 71.0% |

## 4. What a working-tree overlay would weigh

Parsing only the dirty files, and the payload if that structure were sent to a server:

| dirty files | parse | JSON | gzipped |
|---|---|---|---|
| 2 (median commit) | 3–16 ms | 10.0 KB | **1.3 KB** |
| 8 (p90) | 11 ms | 107 KB | 5.4 KB |
| 26 (worst of 60) | 42 ms | 431 KB | 24.3 KB |

Fly bills egress, not ingress, so the upload side is free; 10,000 queries a month at the p90
payload is 51 MB and would cost $0.001 even if it were billed. **The remote-vs-local decision
is worth $0/month.** It is a correctness and trust decision, not a cost one.

A cheaper channel exists and is preferred: sending the **list of dirty filenames** (~100
bytes, no code structure) lets the server intersect them with the files behind its answer and
report precisely which parts are stale, without accepting any unverified structure into the
graph.

## 5. Symbol identity is line-sensitive, and that blocks incremental indexing

Symbol keys embed the starting line: `arc-bench/src/dataset.rs#1:module:dataset`. Inserting
one line at the top of a file therefore changes the identity of every symbol below it.

| identity rule | median symbols changed per commit | median edges |
|---|---|---|
| key includes line number (shipped) | 178 | 887 |
| key is (path, kind, fqn) | **7** | **24** |
| inflation | **25x** | **37x** |

This is load-bearing for the incremental design, not cosmetic. Incremental updating requires
answering "is this the same symbol as last commit", and today the answer is no whenever
anything above it moved. **Line-independent symbol identity is a prerequisite, not a
follow-up.**

## 6. Two bugs found while measuring, both of which produced clean-looking wrong answers

**The blast-radius measurement was silently empty.** It read `symbol.id` and `edge.dst_id`;
the emitted fields are `key` and `dst`. Every lookup returned `undefined`, adjacency was
empty, and the result was a tidy `0.01%` at every depth for every commit — consistent,
plausible, and entirely an artefact of a typo. Corrected numbers are in §3.

**Edge resolution does not exist in the artifact.** All 102,450 edges carry
`resolution: "unresolved"` and `dst: null`; resolution happens in the database when the
artifact is ingested. A measurement that walks the artifact must replicate the loader's
name-resolution rule (unique match -> `derived`, several -> `unverified`) or it will find no
edges at all and report that as a finding.

Both belong to the class this project exists to catch: a number that is wrong in a way that
reads as clean. Neither was caught by a test. Both were caught by re-deriving the number.
