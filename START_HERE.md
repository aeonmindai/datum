# Start here

Read **`HANDOFF.md`** once, top to bottom. It is written to be built from cold. `research/` is
523 KB of sourced prior art — do not read it; open a file only to challenge a specific decision, and
note that each report ends with what its author could **not** verify.

The build target is **`HANDOFF.md` §14 — v0 delivery**. One pass, roughly 4–6 focused hours. There
is no research left in it.

## The kickoff prompt

> Read `HANDOFF.md` in full, then build **v0 per §14**. Seven deliverables: schema + the five
> invariants, verification worker, `/v1` HTTP API, `/mcp` facade, the `datum` CLI, the `/admin`
> panel, and the Arc seed. Deployed to fly.io on `datum.aeonmind.ai`.
>
> Start with #1 and do not move on until its six adversarial writes are each rejected **by the
> database**, with a machine-readable reason, and every test is **mutation-checked both ways** with
> the values reported in both directions. Real Postgres in a container; never stub it.
>
> Before building the admin panel, read `echos_app` and adopt its actual design language — stack,
> tokens, spacing, typography, component patterns, empty and error states. Say in the PR which
> patterns you took. Do not invent a new visual system and do not ship unstyled component defaults.
>
> Constraints that are already decided, do not relitigate: Fly Managed Postgres is **PG16**, so the
> contradiction constraint is `EXCLUDE USING gist` with `btree_gist`, not PG18 `WITHOUT OVERLAPS`.
> `min_machines_running = 1` — never scale to zero, it breaks the read SLO. MCP is a **facade**, not
> the substrate; `/v1` is the real interface. Confidence is **earned**: nothing may be asserted as
> `measured`, the verification worker promotes it.
>
> Deliver a branch and a PR. Report what you built, the six rejection messages verbatim, the
> mutation-check values both ways, and what you did **not** do.

## Secrets — read before you deploy

Nothing secret goes in this repo. It is public.

```
fly secrets set DATUM_ADMIN_PASSWORD_HASH='<argon2id hash>'   # ask Jish for the password
fly secrets set DATUM_SESSION_SECRET='<random 32 bytes>'
fly secrets set DATABASE_URL='<from fly mpg>'
```

The admin password is a single shared password by explicit decision, for now. Store the **argon2id
hash**, never the plaintext, and compare in constant time. It should be rotated once the panel is
up — treat the current value as already disclosed.

## The stop gate — read this before you get attached

**M2 comes after v0 and it can kill the project.**

A plain text file plus `grep` scores **74.0%** on LOCOMO; Mem0's graph variant scores 68.5%;
MemoryBench found no memory system consistently beats simply using all task context. If Datum cannot
beat both full-context and file-plus-grep by **≥10 points** on real data, it should not exist.

The corpus is real and already available: the Arc mission record, 21,619 lines, 449 in-place
retraction markers, known-dead numbers, and two divergent copies of the same `FACTS.md`.

Do not soften this because v0 went well. That is the failure mode.

## Guardrails

- **Never extract facts from prose.** A human or a verified instrument asserts; Datum records. A
  customer audit of 10,134 mem0 entries found **97.8% junk**, including 808 copies of one
  hallucinated preference manufactured by a recall→re-extraction loop.
- **Never rebuild Temporal.** Datum holds beliefs, not executions.
- **Never redefine a predicate.** Add a new name. Rewriting stored events destroys the ability to
  reproduce belief as of the rewrite, which is the headline feature.
- **Embeddings are never a fact.** Separate channel, labelled fuzzy.
- **No `LISTEN/NOTIFY`.** Global `AccessExclusiveLock` on commit serialises the instance. Outbox
  table in v0; NATS when projections land.
- **Six MCP tools, not thirty.** Every tool definition is injected into every agent session.

## Open decisions

`HANDOFF.md` §16. The one that shapes the schema: **when a human contradicts an instrument, is that
blocking or advisory?** My recommendation is advisory — allow it loudly, both rows stay live, a
resolution is required. Decide before writing the exclusion constraint.

## Contributing

Apache-2.0. Copyright stays with Aeonmind AI so the licence can change for future versions if the
commercial shape changes.
