# Datum

**The reference every agent measures from.**

A datum is the fixed point measurements are taken from. In surveying it is specifically what makes
independent instruments agree — the job here, for independent agents. From Latin *datum*, "that
which is given."

*Is that **on datum**?* — is the claim verified. *Take a datum* — read current truth.
*That's **off datum*** — superseded. *The **datum of record*** — this system.

Datum is a self-hostable store of **assertions** — facts, numbers, rules, missions and failures —
that any number of agents, worktrees, branches and humans can read and correct, where:

- **Nothing is written without evidence.** No provenance, no write. Rejected server-side.
- **Nothing is ever mutated.** A correction is a new assertion superseding an old one, so *"what did
  we believe on 19 August?"* is a query, not an archaeology project.
- **Two contradicting measurements cannot both be live.** Physically un-insertable. A *human*
  contradicting a measurement is allowed, loudly, and surfaces as a conflict needing resolution —
  never a silent last-write-wins.
- **Confidence is earned.** Nothing may be asserted as `measured`; a worker promotes it only after
  confirming the commit resolves and is contained where claimed.
- **Retrieval is exact-first.** Structured, then full-text. Embeddings are a separate, labelled,
  fuzzy channel and never returned as fact.
- **Facts inherit across projects.** `org → project → mission → agent`, nearest scope wins. Each
  repo is `global` or `isolated`, toggled whenever you like.
- **Humans read projections.** Linear and Discord are downstream read models, never the source.

## Status

**Design complete, not yet implemented.** Start at [`START_HERE.md`](./START_HERE.md), then
[`HANDOFF.md`](./HANDOFF.md) — written to be built from with no prior context.

## Self-hosting

One org per deployment, no tenant setup, nothing phoning home. Two paths, same image:

```bash
# anywhere
docker compose up -d
datum migrate && datum init

# on fly.io
fly launch && fly secrets set \
  DATUM_ADMIN_PASSWORD_HASH="$(datum hash-password)" \
  DATUM_SESSION_SECRET="$(openssl rand -hex 32)"
```

`datum init` creates your org scope, the first admin and the first API key. Set `DATUM_ORG` to your
own name — nothing about the authors is hardcoded. The server **refuses to boot** without an admin
password hash and session secret, because a self-hostable product that ships a default password is
a vulnerability, not a convenience.

Then point an agent at it:

```bash
datum link                 # register this repo
datum mode global          # or: isolated
datum status
```

MCP lives at `/mcp`, the real API at `/v1`, the admin panel at `/admin`.

## Why

Measured from 11 days of one agentic project: mean context **538,820 tokens** per turn, **8**
compaction events, **4.17 billion** cache-read tokens for 11.3 M output, **52%** of shell calls spent
on provenance archaeology and **2.9%** on compiling. Two divergent copies of the same knowledge base,
449 retractions struck in place, 435 commits stranded on branches. All substrate problems, and none
of them fixable by prompting.

## The bar

A plain file plus `grep` scores **74.0%** on LOCOMO; Mem0's graph variant scores 68.5%. Datum must
beat both full-context and file-plus-grep by **≥10 points** on real data, or it should not exist.
That gate comes before any feature work, and it is allowed to kill the project.

## What the field has not solved

- No published memory architecture enforces provenance on write.
- The best multi-hop contradiction score anywhere is **7.0%**, and no system raises a contradiction
  for resolution — every one resolves silently by recency.
- Naive append-only is *worse than no memory* under fact reversal (0.210 vs 0.309).
- Zero of 19 surveyed products treat a human tracker as a downstream projection.
- Nobody implements nearest-scope-wins, and nobody gates a goal on a machine-checkable predicate.

Evidence, ~200 URLs, in [`research/`](./research).

## License

Apache-2.0. This repo is the complete single-tenant server — no enterprise stubs, no paid-feature
walls. Multi-tenancy and enterprise features will live in a separate private repo that depends on
this one.
