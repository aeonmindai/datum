# Datum — build handoff

**A datum is the fixed reference point every measurement is taken from.** In surveying and geodesy
the datum is what makes independent instruments agree — which is exactly the job here: making any
number of agents, projects, worktrees and humans agree on the same facts, the same mission, and each
other. From Latin *datum*, "that which is given": the store of what is given.

The vocabulary is the design. *Is that on datum?* — is the claim verified. *Take a datum* — read
current truth. *That's off datum* — superseded. *The datum of record* — this system.

This document is written to be built from in a fresh session with no prior context. Read it
top to bottom once. The evidence for every design decision is in `research/` (523 KB, ~200 URLs,
five parallel research slices, 2026-08-24).

---

## 0. Why this exists — the measured failure it replaces

Not a hypothesis. Measured from 11 days of Claude Code transcripts on the Arc project
(33,850 records, `~/.claude/projects/-Users-jish-Documents-GitHub-arc/`):

| metric | value |
|---|---|
| mean context per assistant turn | **538,820 tokens** (p90 899k, max 1.0M) |
| turns above 150k context | 7,126 of 7,850 (**91%**) |
| compaction events | **8** in 11 days |
| cache-read tokens : output tokens | 4,166,105,524 : 11,287,430 = **369 : 1** |
| shell calls that were git/gh provenance archaeology | **543 of 1,036 (52%)** |
| shell calls that ran `cargo` | **30 (2.9%)** |
| file writes into the agent's own notes | **270 of 337 (80%)** |
| file writes into source code | **5** |
| engaged time vs calendar time | 93 h over 10.8 days |

Root causes, all structural:

1. **Two divergent copies of the same knowledge base.** One in git, one un-versioned. Five files
   existed in both with different content; `FACTS.md` differed by 239 lines. The copy the
   orchestrator re-read after every compaction was frozen two days behind — missing precisely the
   retraction table that would have stopped it repeating dead numbers.
2. **Retractions struck in place.** 449 correction markers across 21,619 lines, one per 48. At 500k
   context, retrieval returns the most *emphatic* match, not the most *recent*. Dead headline
   numbers won every time. The project's live target appeared **nowhere** in its own corpus.
3. **No machine-readable state**, so "is this claim real?" cost hundreds of git calls per session.
4. **Work parked on unmerged branches**, so the repo at HEAD was not the truth. An audit found 155
   branches outside master: 11 with no shared ancestor at all, 29 patch-equivalent to landed work,
   and **115 carrying 435 commits that landed nowhere**, plus 17 of 141 worktrees with uncommitted
   changes.

Every one of those is a *substrate* problem. No amount of prompting fixes them.

---

## 1. What the field has and has not solved

Full detail in `research/`. The five findings that define the product:

**1. Mandatory provenance on write is a universal blind spot.** The mnemonic-sovereignty survey
(arXiv:2604.16548) audits six architectures against nine governance primitives and states that for
the write gate "no published architecture reaches explicit support". Verified in Graphiti source:
`EntityEdge` has no confidence field and its provenance link defaults to `[]`. MINJA
(arXiv:2503.03704) achieves >95% memory-injection success with query-only access.

**2. Optional provenance provably decays.** Wikidata went from 1.3% of statements carrying a
reference (Oct 2015) to ~68% after a decade, with referencing quality 0.58/1. Optional means absent.

**3. Contradictions are detected but never adjudicated.** MemoryAgentBench (arXiv:2507.05257)
FactConsolidation at 262K: the best multi-hop conflict score **anywhere is 7.0%**; Claude-3.7-Sonnet
scores 0.0; BM25 from 1994 beats Mem0, MemGPT and GraphRAG on single-hop. Every shipped mechanism
auto-resolves silently — Graphiti by recency, TEPA by posterior. **No system emits a contradiction
object requiring resolution.** Prior art for wanting one is FA/C, Lesser & Corkill 1981.

**4. Naive append-only is worse than no memory.** TEPA (arXiv:2608.07429, 50 seeds, p<0.001): under
full fact reversal, append-only scores 0.210 and last-write-wins 0.210, both **below no-memory at
0.309**. HaluMem (arXiv:2511.03506): Mem0 applies 1.45% of required updates and omits 98.51%;
memory accuracy 46.01%. The lesson is not "don't append" — it is that **supersession must be
retrieval-effective, not merely recorded.**

**5. The bar is grep.** Letta measured a plain file plus `grep` at **74.0%** on LOCOMO versus Mem0's
68.5% graph variant, with full-context ~73%. MemoryBench (arXiv:2510.17281): "none of the advanced
memory-based LLMsys can consistently outperform RAG baselines that simply use all task context."
LOCOMO itself is unusable — an independent audit found 6.4% answer-key errors and a judge that
accepts 62.81% of intentionally wrong answers.

> **If Datum cannot beat both full-context and file-plus-grep by ≥10 points on our own data,
> it has no reason to exist.** That is the acceptance gate for the whole project, and it is the
> single most important sentence in this document.

**Competitive position.** Three products each own roughly a third of this shape and **not one owns
two**: Zep (bitemporality + provenance-derived authorization), xmemory (write-time validation +
exact-first retrieval), TencentDB Agent Memory (team governance: owner/version/visibility ACLs).
Zep is closest and stops short at: no confidence taxonomy, no write rejection, supersession is an
LLM guess rather than an assertion, hybrid rather than exact-first retrieval, flat scopes that
isolate but never resolve, agents are merely API keys, no missions, no projections. Zep's own
bitemporality is not honoured end-to-end — Graphiti issue #1489 shows the MCP `add_memory` tool has
no `reference_time` and hardcodes `datetime.now()`. **Having the columns is not having the
semantics.**

**The market runs the other way on projections.** Zero of 19 surveyed products treat a human tracker
as a downstream projection; the trend is trackers as the source of truth for agents. Cross-project
linkage is equally empty — projects are monetised isolation units (Mem0 gates multi-project at
$249/mo, Zep caps at 5–10). **Nobody implements nearest-scope-wins.**

**And the cautionary tale.** Hearsay-II's flexible shared blackboard lost to Harpy, a boring
precompiled monolith, on the same task in the same lab in the same year: 16% versus **5%** semantic
error, 2–20× slower. Erman's own post-mortem: "the advantages of blackboard systems do not scale
down to simple problems." Blackboards died not from being wrong but because every team rebuilt the
machinery from scratch and there was no commercial tooling. **Datum is that missing machinery.
That is the bet.**

---

## 2. Non-goals

- **Not a durable execution engine.** Do not rebuild Temporal, Restate or Inngest. Datum holds
  *beliefs*, not *executions*.
- **Not a vector database.** Embeddings are a secondary, separately-typed, clearly-labelled channel.
- **Not a message bus.** Agent-to-agent chat is explicitly optional and lowest priority.
- **Not a tracker.** Linear and Discord are read models for humans.
- **Not an extraction pipeline.** Datum never invents facts from prose. The mem0 failure below
  is what that produces.

> A customer audited 10,134 mem0 production entries over 32 days: **97.8% junk**, 224 survivors, 38
> clean as-is, including **808 copies of a hallucinated "User prefers Vim"** manufactured by a
> recall→re-extraction feedback loop, and 2.1% privacy leaks. Upgrading the model barely moved it:
> "the extraction prompt is the bottleneck, not the model" (mem0 issue #4573). Their top request is
> literally "make the pipeline provenance-aware."
>
> **Datum writes what it is told, with evidence, or rejects the write.**

---

## 3. The core object: an assertion

Immutable. Content-addressed. Bitemporal. Never updated, never deleted.

```jsonc
{
  "id": "a_01JQ...",                  // ULID, monotonic
  "hash": "sha256:...",               // over the canonical body; the identity
  "scope": "org/aeonmind/proj/arc/mission/k9-rebake",
  "subject": "kernel:qtip2b_grouped_gemm",
  "predicate": "share_of_batch_gpu_time_pct",
  "object": { "value": 53, "unit": "% of batch GPU time" },

  "kind": "measured",                 // measured|target|rule|constraint|state|untried|failed|dead
  "binding": true,                    // binding rule vs advisory fact - Jish asked for both
  "confidence": "measured",           // measured|confirmed-by-human|derived|unverified

  "evidence": {                       // REQUIRED. No evidence, no write.
    "repo": "aeonmindai/arc",
    "commit": "4d03b9e2541b9a88f036cdd7640495fb98f16fc9",
    "contained_in": ["release/openrouter-ready"],
    "instrument": "ncu",
    "protocol": "B=256, one H200, produced tokens only, >=256 floor",
    "artifacts": ["sha256:..."],
    "source": "memory/mission/wave51-CB.md:166-186"
  },

  "valid_from": "2026-08-21T00:00:00Z",   // when true in the world
  "valid_to":   null,
  "asserted_at": 4417,                     // assert-time: a monotonic sequence, NOT a clock
  "asserted_by": "agent:K2@worktree-a53d",

  "supersedes": "a_01JP...",              // correction = a new assertion, never an edit
  "why": null,                            // REQUIRED for kind=failed|dead
  "reopen_if": null,                       // REQUIRED for kind=failed: the falsifier
  "causality": "evt_7f3c..."               // inherited; see §8
}
```

Design notes that are load-bearing:

- **`asserted_at` is a sequence, not a timestamp.** NATS JetStream KV's bucket-wide revision counter
  is the closest production precedent: a free total order across keys with no clock and therefore no
  clock skew. Use a Postgres sequence or the outbox offset.
- **Bitemporal, both axes.** `valid_from/valid_to` is when the fact was true; `asserted_at` is when
  we learned it. This is what answers *"what did we believe on 19 August?"* — the question that,
  had it been askable, would have exposed the two divergent `FACTS.md` copies immediately.
- **`why` and `reopen_if` are mandatory on failures.** A dead end must carry its own falsifier.
  "ragged pair: −41%, reopen_if: the ragged path stops re-materialising the pair" is actionable;
  "do not re-propose without new evidence" is not.
- **`binding` separates rules from advice.** Violating a binding rule is a regression; advisory
  facts are guidance. Jish asked for both explicitly.

### The evidence-class taxonomy

Nobody in the field has one. It is the cheapest differentiator in this document.

| class | meaning | may an agent act on it? |
|---|---|---|
| `measured` | came off hardware/an instrument, with protocol | yes |
| `confirmed-by-human` | a named human asserted it; outranks documents | yes, and it wins ties |
| `derived` | computed from other assertions; carries its inputs | yes, if inputs are live |
| `unverified` | recorded but unproven | **no** — verify or report blocked |

Retrieval always returns the class. A bare number cannot leave the system.

---

## 4. The five invariants, enforced server-side

A write that violates any of these is **rejected with a machine-readable reason**. Not warned. Not
logged. Rejected. This is the entire product.

1. **No assertion without evidence.** Nanopublications are the precedent: a nanopub is only
   well-formed if head, assertion, provenance and pubinfo all exist as distinct graphs and
   provenance references the assertion. Steal the *shape*; reject the RDF substrate (RDF 1.2 is
   still Candidate Recommendation and RDF-star semantics assert embedded triples, which is poison
   for a contradiction store).
2. **No mutation, ever.** `REVOKE UPDATE, DELETE` on the assertions table. Corrections are new rows
   with `supersedes`. Empirical support is not theoretical: Decker et al. (IJCAI-91) measured on a
   16-processor Sequent that append-only is *why* concurrent writes are cheap — "because hypotheses
   are never deleted... only one lock is ever acquired at a time, deadlock is impossible" — reaching
   4.8× on 5 processors.
3. **No two live contradicting assertions.** Postgres 18 shipped the application-time half of
   SQL:2011: `WITHOUT OVERLAPS` on a unique constraint over
   `(scope, subject, predicate, valid_period)` makes a contradiction **physically un-insertable**.
   No bitemporal engine offers this. It is the strongest single argument for Postgres over
   XTDB or Datomic, and it turns the field's hardest unsolved problem into a declarative constraint.
4. **No unverifiable claim of landing.** Any evidence naming a repo and commit is re-verified
   asynchronously: does the commit exist, is it contained in the named branch? The verification
   outcome is itself an assertion. Precedent: GitHub Copilot Memory validates citations against the
   current branch — the only shipped mechanism of this kind found anywhere.
5. **No target without a machine-checkable gate.** See §6.

---

## 5. Scopes, and nearest-scope-wins

```
org/aeonmind
  proj/arc
    mission/k9-rebake
      agent/K2
```

A read resolves the **union** along the path, with the nearest scope winning ties. This is the
mechanism that makes "global facts and numbers" and "fits any given project" the same feature, and
it is the one nobody ships. `AGENTS.md`'s only conflict rule is proximity — "the closest AGENTS.md
to the edited file wins" — which is the right instinct implemented in the filesystem. Do it in data.

Cross-project edges are first-class: `applies_to`, `derived_from`, `contradicts`. "cudnn costs −62%
on H200 decode" is an org-level assertion every project inherits for free. **That inheritance is the
compounding asset and the commercial wedge** — the more projects, the more valuable, which is the
opposite of every competitor, where projects are billing-isolation units.

---

## 6. Missions, with gates that are predicates

Nobody models goals with machine-checkable predicates. Every production gate found in the research
is an LLM judgement (OpenHands `GoalVerdict`) or a human-written shell hook (Claude Code agent
teams, which is the only machine-enforced gate found in a shipped coding agent — and it is
single-machine, unversioned and off by default).

```jsonc
{ "id": "m_k9rebake",
  "scope": "org/aeonmind/proj/arc",
  "statement": "Bake DeepSeek-V4-Flash into K=9/V=4/L=12 and serve it.",
  "state": "active",                       // proposed|active|blocked|closed
  "gates": [
    { "subject": "engine", "predicate": "aggregate_tok_s_at_b256",
      "op": ">=", "target": 14000,
      "requires_confidence": "measured",   // <- the novel part
      "reached": false },
    { "subject": "bake", "predicate": "seconds_per_layer",
      "op": "<=", "target": 83.7,
      "requires_confidence": "measured",
      "reached": null,
      "note": "reached once, then lost to model confusion - recovery, not research" }
  ],
  "supersedes": "m_k9rebake@v3" }
```

Three properties no existing system has: **a gate names the evidence class it will accept**; a
mission is **versioned** by supersession, so an edited objective does not silently erase the old
one; and one query answers *"what is the mission right now"* for every agent on every machine.

---

## 7. The registry — how hundreds of things know each other

Every agent, worktree, branch, webhook and human is a **node** with a stable id, a scope, a role, a
heartbeat and a `last_seen`. KQML shipped exactly this in 1994 (the *facilitator*, with
`broker`/`recruit`/`recommend` over a service registry); no modern agent stack has it, and NANDA
demonstrates the shape works at scale — 13,600 agents with real liveness spread over months.

This is what makes 141 worktrees legible instead of frightening. A worktree node links to its
branch, its project, its mission and its owning agent, and the audit in §0 becomes a query rather
than a forensic exercise.

Agent-to-agent messaging is **optional and last**. If it is built, use commitment semantics
(Singh 1998) — verifiable by an observer holding only the message log — never the mentalistic
semantics that killed KQML and FIPA-ACL, whose reference implementation JADE was abandoned by its
own team in 2021.

---

## 8. Projections — humans read, they do not write

The event log is the truth. Linear and Discord are **derived read models**. Never two-way sync;
sync between two writable systems is a distributed-consensus problem nobody has solved cheaply.

Concrete constraints, all vendor-documented, all of which shape the design:

- **Linear:** `actor=app` **cannot hold `admin` scope**, and `admin` is required to create or read
  webhooks via the API. Any design where the agent provisions its own webhook is **dead on
  arrival** — webhooks must be configured at app level in developer settings.
- **Discord:** **50 requests/second global per bot**, independent of per-route limits. Hundreds of
  chatty agents will exhaust this; batch and coalesce, one digest per mission event, never one
  message per assertion.
- **GitHub App:** 5,000 req/hr minimum, +50/hr per repo above 20 repos, **hard ceiling 12,500/hr.**
- **Steal GitLab's `X-Gitlab-Event-UUID` verbatim in concept:** one id, fresh for an
  externally-caused event and **inherited by everything that event causes**. That single field gives
  loop detection, causal chains and blast-radius attribution — hence `causality` on the assertion.
  It is the only shipped, primary-sourced solution to webhook recursion in the research.

---

## 9. Retrieval — exact-first, and fast

Requirement is millisecond, no guesses. Therefore:

1. **Structured filter first**: scope path + subject + predicate + `kind` + live-only. This is an
   index seek and it is exact.
2. **Full-text second** (`tsvector`) over `claim` text.
3. **Embeddings third, in a separately-typed channel, always labelled `fuzzy`, never returned as a
   fact.** Vector similarity returns "close enough" with no signal that it is the wrong neighbour —
   which is the failure mode this system exists to eliminate. Non-negotiable.
4. **Sub-10ms hot reads over accretion storage** via XTDB v2's published recency heuristic: collapse
   the temporal dimensions into one over-estimating scalar, take the per-file maximum, and elide
   whole files from as-of-now queries. Plus a partial index on live rows.
5. **Retrieval must be supersession-aware or the whole thing is worse than nothing** (§1 finding 4).
   A superseded assertion must not surface in a default read, ever. Wikidata's
   preferred/normal/deprecated rank with a materialised best-rank view is the model to copy.

---

## 10. Recommended stack

| layer | choice | why |
|---|---|---|
| store | **Postgres 18** | `WITHOUT OVERLAPS` gives invariant 3 declaratively. `REVOKE UPDATE/DELETE` gives invariant 2. Boring, hostable anywhere. |
| ordering | Postgres sequence as `asserted_at` | total order, no clock, no skew |
| fanout | **NATS JetStream via transactional outbox** | **never `LISTEN/NOTIFY`** — it takes a global `AccessExclusiveLock` on commit and serialises the entire instance; three dated production outages in the research |
| hot cache | per-worktree **SQLite**, content-addressed, read-through, offline outbox | immutable rows cache perfectly; no CRDT needed, because append-only with a server-assigned sequence has no merge conflict |
| search | `tsvector` + partial live index | exact-first |
| transport | HTTP + **an MCP server** + a small CLI | MCP is how any harness plugs in without an SDK |
| hosting | Postgres (Neon or Supabase) + one small API service | Neon branching is for as-of debugging environments, **not** per-worktree: 10–25 branches/project practical, $1.50/branch-month, and scale-to-zero breaks the read SLO |

**Rejected:** Datomic — Jepsen found intra-transaction operations execute as if concurrent, so two
individually invariant-preserving transaction functions jointly produce a record that is both
approved and denied. That is exactly the bug class that would let a supersession and a contradiction
commit together and corrupt the core invariant. Nubank considers it expected behaviour.

**Rejected:** RDF/RDF-star as substrate (see §4.1). **Rejected:** CRDTs — unnecessary under
server-assigned ordering. **Rejected:** Ray as a state substrate — "if the GCS fails, the entire Ray
cluster fails."

---

## 11. Auth — the thing that has already cost us twice

Arc lost a running job twice to a **single-use refresh token raced by concurrent agents**. This is
not a bug we hit; it is the specification working as designed. RFC 9700 §4.14.2 concedes the
authorization server "cannot determine which party submitted the invalid refresh token", so the
correct spec-compliant response is to revoke the entire token family — killing the whole fleet.

**Therefore: never issue refresh tokens to agents. Ever.** One org-level grant. Each agent presents
a platform OIDC workload assertion and receives, via RFC 8693 token exchange, a **5–15 minute,
single-audience, scope- and mission-bound access token**. Expiry replaces revocation. Concurrency
becomes a non-event because there is nothing to rotate.

---

## 12. Failure modes to design against

1. **Event rewriting destroys as-of reproducibility.** The moment you up-cast or rewrite stored
   events you permanently lose the ability to reproduce belief as of the rewrite — which destroys
   the headline claim. Mitigation is Hickey's accretion/relaxation/fixation applied to predicates
   and schema: **never redefine a predicate, always introduce a new name.** `research/` lists 14
   named event-sourcing failure modes with war stories; this is the deadliest for us.
2. **Extraction loops manufacture facts.** See mem0's 808 hallucinated duplicates. Datum never
   extracts. A human or a verified instrument asserts.
3. **Memory injection.** >95% success with query-only access in the published attack. Mitigations:
   evidence required on write, scope-bound tokens, and provenance-derived read authorization (Zep's
   episode-metadata projection is the right precedent).
4. **Naive append-only under-performs no memory.** Retrieval must hide superseded rows by default.
5. **Silent last-write-wins.** Every competitor does this. Raise a `contradiction` object instead
   and refuse the write. If we ship one thing, ship this.
6. **Becoming a library.** If agents end up grepping a big text dump, we have built the thing we
   replaced. The §1 acceptance gate is the defence.

---

## 13. Milestones

Each has a falsifiable acceptance test. No milestone is "done" without it.

- **M0 — schema + invariants (no service).** Postgres migrations; assertions table with
  `REVOKE UPDATE/DELETE`; `WITHOUT OVERLAPS` constraint; scope resolution as a SQL function.
  *Accept:* six adversarial writes are rejected — no evidence, mutation attempt, overlapping
  contradiction, `failed` without `reopen_if`, unverifiable commit, superseding a superseded row.
  Each rejection carries a machine-readable reason. Mutation-test every assertion both ways.
- **M1 — API + CLI + MCP server.** `assert`, `supersede`, `ask`, `state`, `mission`, `nodes`,
  `check`. *Accept:* p99 read <10 ms at 1M assertions; as-of query returns the belief state of an
  arbitrary past sequence number; `check` re-verifies every commit-bearing assertion against git.
- **M2 — the benchmark that decides whether this ships.** Replay the real Arc corpus: 21,619 lines,
  449 retraction markers, the known-dead numbers, the two divergent `FACTS.md` copies. Baselines:
  full-context, and file-plus-grep. *Accept:* **≥10 points over both**, plus 100% on a
  stale-fact-resistance set where the correct answer requires honouring a supersession, plus zero
  dead numbers surfaced in a default read. **If this fails, stop building.**
- **M3 — registry + missions.** Nodes with heartbeats; missions with predicate gates;
  `mission current` answers in one call from any machine. *Accept:* the Arc orphan audit
  (155 branches → 11 disjoint / 29 safe / 115 hold) is reproduced as a registry query.
- **M4 — projections.** Discord digest and a Linear bot, both write-only, both driven by the outbox,
  with the causality id threaded through. *Accept:* an ingest storm produces no webhook recursion,
  and Discord stays under 50 rps by coalescing.

---

## 14. Open questions for Jish

1. **Multi-tenant from day one, or aeonmind-only first?** It changes the auth model materially.
   Recommendation: single-tenant schema, multi-tenant-shaped scopes, so the migration is additive.
2. **Is the contradiction object blocking or advisory** on a `confirmed-by-human` write? A human
   contradicting an instrument is a real event and probably should be allowed, loudly, with both
   rows live and a resolution required.
3. **Does GSM8K 96% get an assertion?** Under these rules it is `confirmed-by-human` with no commit
   and no protocol, so it is unpublishable until re-measured. That is correct behaviour and it is
   also a live example of the system telling you something you may not want to hear.
4. **Product or internal?** If product: the wedge is the contradiction adjudicator plus the
   evidence-class taxonomy, neither of which exists anywhere, and the moat is cross-project
   inheritance.

---

## 15. Evidence

`research/` — 523 KB, five slices, every claim URL-carrying:

| file | slice |
|---|---|
| `research-memory-papers.md` | agent-memory literature, benchmarks, what nobody has solved |
| `research-memory-startups.md` | 19 commercial products, positioning, the mem0 audit |
| `research-agent-coordination.md` (+ `ac-protocols`, `ac-durable`, `ac-production`) | blackboards, tuple spaces, KQML/FIPA, MCP/A2A, durable execution, what production agents actually do |
| `research-bitemporal-provenance.md` | Datomic/XTDB/SQL:2011, nanopublications, PROV-O, event-sourcing failure modes, stack recommendation |
| `research-projections-and-naming.md` | Linear/Discord/GitHub limits, auth, the naming study |

Each report also lists what its author **could not verify**. Those gaps are honest and should be
closed before any external claim is made — several load-bearing competitor facts are
secondary-sourced and flagged as such.

---

## Appendix — why "Datum"

A datum is the fixed reference from which measurements are taken. In surveying and geodesy it is
specifically the thing that makes **independent instruments agree** — the exact job this system does
for independent agents. Latin *datum*, "that which is given." It is also the singular of *data*,
which quietly says *one verified fact* against the noise.

The name was chosen on the vocabulary test: *on datum* / *off datum* / *take a datum* / *the datum
of record* all mean something precise and useful, so the product teaches itself.

### What it cost

`research/research-projections-and-naming.md` records an earlier study of fifteen anatomical names
that recommended **Commissure**. It won on collision data and was rejected on taste — it is clinical
and hard to say. That report is left unedited on purpose: it is the record of a decision, not a
description of the outcome. Two names it eliminated are worth remembering, because both are live
competitors in or beside our category:

- **Engram** — an SF AI-memory startup, **$98M** raised June 2026 at a $600M valuation. Our exact
  category.
- **Callosum** — a UK AI-infrastructure startup, **$100M** seed August 2026, plus Rolls Royce Power
  Systems holding the mark in classes 9 and 42.

### Datum's own collision reality, measured 2026-08-24

| surface | status |
|---|---|
| npm / PyPI / crates.io | all **taken** — use the scope `@aeonmind/datum`, binary `datum` |
| `datum.com` | 302s to **microchip.com**. Unbuyable. |
| `datum.ai`, `datum.sh` | live products |
| `datum.dev` | **parked** on GoDaddy (`LANDER_SYSTEM="PW"`, `ap:"parking"`) — make-offer target |
| `datum.io` | bare A record, no HTTPS — dormant, worth an inquiry |
| `datum.build` | **available** |
| `datum.aeonmind.ai` | owned; use it now |

🔴 **Open risk, must be closed before any public launch.** Microchip owns `datum.com` through the
Datum Inc. timing-and-frequency-standards lineage, so a registered `DATUM` in **Nice class 9** is
likely. Software sits in class 42 and a common dictionary word is hard for anyone to own broadly,
but this needs a real trademark search. A TMview query filtered to USPTO + EUIPO, classes 9 and 42,
status Filed or Registered, is the check; it was blocked by bot protection during this session.
**Do not announce, fundraise or file on this name until that search is done.** Internal use and a
private repo carry no such exposure, so building can start immediately.

Not a clearance opinion. Nothing here has been reviewed by counsel.
