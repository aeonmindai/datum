# Commissure

**The tract between agents.**

A commissure is the white-matter bundle that carries shared state between separate hemispheres. The
corpus callosum is merely the largest one.

Commissure is a remote, multi-project store of **assertions** — facts, numbers, rules, missions and
failures — that any number of agents, worktrees, branches and humans can read and correct, where:

- **Nothing is written without evidence.** No provenance, no write. Rejected server-side.
- **Nothing is ever mutated.** A correction is a new assertion that supersedes an old one, so
  *"what did we believe on 19 August?"* is a query.
- **Two contradicting live facts cannot exist.** They are physically un-insertable, and the conflict
  surfaces as an object requiring resolution instead of a silent last-write-wins.
- **Retrieval is exact-first.** Structured, then full-text. Embeddings are a separate, labelled,
  fuzzy channel and never returned as fact.
- **Facts inherit across projects.** `org → project → mission → agent`, nearest scope wins.
- **Humans read projections.** Linear and Discord are downstream read models, never the source of
  truth.

## Status

Design complete, not yet implemented. **Start at [`HANDOFF.md`](./HANDOFF.md)** — it is written to
be built from with no prior context.

## Why

Measured from 11 days of one agentic project: mean context **538,820 tokens** per turn, **8**
compaction events, **4.17 billion** cache-read tokens for 11.3 M output, **52%** of shell calls spent
on provenance archaeology and **2.9%** on compiling. Two divergent copies of the same knowledge base,
449 retractions struck in place, and 435 commits stranded on branches. All substrate problems.

## The bar

A plain file plus `grep` scores **74.0%** on LOCOMO; Mem0's graph variant scores 68.5%. Commissure
must beat both full-context and file-plus-grep by **≥10 points** on real data, or it should not
exist. That gate is M2 in the handoff, and it comes before any feature work.

## What the field has not solved

- No published memory architecture enforces provenance on write.
- The best multi-hop contradiction score anywhere is **7.0%**, and no system raises a contradiction
  for resolution — every one resolves silently by recency.
- Naive append-only is *worse than no memory* under fact reversal (0.210 vs 0.309).
- Zero of 19 surveyed products treat a human tracker as a downstream projection.
- Nobody implements nearest-scope-wins, and nobody models a goal with machine-checkable gates.

Evidence, with ~200 URLs, in [`research/`](./research).

## License

Undecided. See handoff §14.
