# Datum

**The reference every agent measures from.**

A datum is the fixed point measurements are taken from. In surveying it is specifically what makes
independent instruments agree — the job here, for independent agents. From Latin *datum*, "that
which is given."

*Is that **on datum**?* — is the claim verified. *Take a datum* — read current truth.
*That's **off datum*** — superseded. *The **datum of record*** — this system.

Datum is a remote, multi-project store of **assertions** — facts, numbers, rules, missions and
failures — that any number of agents, worktrees, branches and humans can read and correct, where:

- **Nothing is written without evidence.** No provenance, no write. Rejected server-side.
- **Nothing is ever mutated.** A correction is a new assertion superseding an old one, so *"what did
  we believe on 19 August?"* is a query.
- **Two contradicting live facts cannot exist.** Physically un-insertable, and the conflict surfaces
  as an object requiring resolution instead of a silent last-write-wins.
- **Retrieval is exact-first.** Structured, then full-text. Embeddings are a separate, labelled,
  fuzzy channel and never returned as fact.
- **Facts inherit across projects.** `org → project → mission → agent`, nearest scope wins.
- **Humans read projections.** Linear and Discord are downstream read models, never the source.

## Status

Design complete, not implemented. **Start at [`HANDOFF.md`](./HANDOFF.md)** — written to be built
from with no prior context.

## Why

Measured from 11 days of one agentic project: mean context **538,820 tokens** per turn, **8**
compaction events, **4.17 billion** cache-read tokens for 11.3 M output, **52%** of shell calls spent
on provenance archaeology and **2.9%** on compiling. Two divergent copies of the same knowledge base,
449 retractions struck in place, 435 commits stranded on branches. All substrate problems.

## The bar

A plain file plus `grep` scores **74.0%** on LOCOMO; Mem0's graph variant scores 68.5%. Datum must
beat both full-context and file-plus-grep by **≥10 points** on real data, or it should not exist.
That is M2, and it comes before any feature work.

## What the field has not solved

- No published memory architecture enforces provenance on write.
- The best multi-hop contradiction score anywhere is **7.0%**, and no system raises a contradiction
  for resolution — every one resolves silently by recency.
- Naive append-only is *worse than no memory* under fact reversal (0.210 vs 0.309).
- Zero of 19 surveyed products treat a human tracker as a downstream projection.
- Nobody implements nearest-scope-wins, and nobody gates a goal on a machine-checkable predicate.

Evidence, ~200 URLs, in [`research/`](./research).

## Name

`@aeonmind/datum`, binary `datum`, `datum.aeonmind.ai` today. `datum.com` belongs to Microchip;
`datum.dev` is parked and is the acquisition target; `datum.build` is available.
**A trademark search in Nice classes 9/42 is an open blocker before any public launch** — see
handoff appendix.

## License

Undecided. See handoff §14.
