# Start here

Three things, in order. Total reading before you write code: about 15 minutes.

1. **`HANDOFF.md`** — the whole design. Written to be built from cold. Read it once, top to bottom.
2. **`research/`** — the evidence. Do not read it now. Open a file only when you want to challenge a
   specific decision; each report ends with what its author could **not** verify.
3. **This file** — how to begin.

## The kickoff prompt

Paste this into a fresh agent session with the repo checked out. It is deliberately narrow.

> Read `HANDOFF.md` in full, then implement **M0 only**: the Postgres schema and the five
> invariants. No API, no CLI, no service.
>
> M0 is done when six adversarial writes are each **rejected by the database or a constraint
> function**, not by application code, and each rejection carries a machine-readable reason:
>
> 1. an assertion with no `evidence`
> 2. an `UPDATE` or `DELETE` against the assertions table
> 3. an assertion that overlaps an existing live assertion on
>    `(scope, subject, predicate, valid_period)`
> 4. `kind = 'failed'` with no `reopen_if`
> 5. `kind = 'measured'` whose `evidence.commit` does not resolve in the named repo
> 6. an assertion superseding an already-superseded assertion
>
> Write the tests first. **Mutation-check every assertion both ways** — prove each test fails when
> the constraint is removed, and report the values in both directions. A test that passes while its
> assertion is unreachable is worse than no test.
>
> Use real Postgres 18 in a container. Do not stub the database. Do not add features that are not on
> this list, and do not start M1.

## Why that shape

M0 is only schema because the five invariants **are** the product. Everything above them is
plumbing that can be rewritten in an afternoon; the invariants cannot be retrofitted. If a
contradiction can reach the table once, every downstream guarantee is decoration.

The reason the checks must live in the database and not the application is in `HANDOFF.md` §1:
Wikidata's provenance was optional and went from 1.3% coverage to 68% over a decade, quality
0.58/1. Optional means absent. A constraint that application code can route around is optional.

## The stop gate — read this before you get attached

**M2 can kill the project, and it comes before any feature work.**

A plain text file plus `grep` scores **74.0%** on LOCOMO. Mem0's graph variant scores 68.5%. If
Datum cannot beat both full-context and file-plus-grep by **≥10 points** on real data, it should not
exist and you should stop building. The corpus to test against is real and already available: the
Arc mission record, 21,619 lines with 449 in-place retraction markers, known-dead numbers, and two
divergent copies of the same `FACTS.md`.

Do not soften this gate later because M0 and M1 went well. That is the failure mode.

## Guardrails

- **Never extract facts from prose.** A human or a verified instrument asserts; Datum records. A
  customer audit of 10,134 mem0 entries found 97.8% junk, including 808 copies of one hallucinated
  preference manufactured by a recall→re-extraction loop. That is what extraction produces.
- **Never rebuild Temporal.** Datum holds beliefs, not executions.
- **Never redefine a predicate.** Add a new name. Rewriting stored events destroys the ability to
  reproduce belief as of the rewrite, which is the headline feature.
- **Embeddings are never a fact.** Separate channel, labelled fuzzy, never returned as truth.
- **No `LISTEN/NOTIFY`.** It takes a global `AccessExclusiveLock` on commit and serialises the whole
  instance. Transactional outbox to NATS JetStream instead.

## Milestones

`HANDOFF.md` §13 has the full list with acceptance criteria. Tracked as issues:

- **M0** schema + invariants — the six rejections above
- **M1** API + CLI + MCP server — p99 read <10 ms at 1M assertions, working as-of query
- **M2** the benchmark that decides whether this ships — **stop gate**
- **M3** registry + missions — reproduce the Arc orphan audit as a query
- **M4** projections — Discord digest and Linear bot, write-only, outbox-driven

## Open decisions

`HANDOFF.md` §14. The one that shapes M0 is: **is a contradiction blocking or advisory when the
writer is a human?** A human contradicting an instrument is a real event and probably should be
allowed, loudly, with both rows live and a resolution required. Decide before you write constraint 3.

## Contributing

Apache-2.0. Copyright stays with Aeonmind AI so the licence can change for future versions if the
commercial shape changes — see `HANDOFF.md` §14.
