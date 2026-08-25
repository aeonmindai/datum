<p align="center">
  <img src="assets/banner.svg" alt="Datum — the datum of record" width="820">
</p>

<p align="center">
  <strong>A memory for your AI agents that cannot make things up.</strong><br>
  Connect it over MCP in one minute. Apache-2.0, self-hosted, runs on Postgres.
</p>

---

## Connect it to your agent

Datum is an **MCP server**. Point Claude, Cursor, or anything else that speaks MCP at it:

```json
{
  "mcpServers": {
    "datum": {
      "url": "https://your-datum/mcp",
      "headers": { "Authorization": "Bearer dtm_live_..." }
    }
  }
}
```

That's it. Your agent gets six tools and nothing to learn:

| tool | what your agent asks |
|---|---|
| **`state`** | what's true here right now? |
| **`ask`** | what is X? |
| **`why`** | how do you know that? |
| **`assert`** | record this |
| **`supersede`** | that was wrong, here's the correction |
| **`nodes`** | who else is working here? |

Six, not thirty — every tool description is injected into every conversation, so a chatty MCP server
is a tax you pay on every message forever.

## What your agent gets back

Small, and impossible to misread:

```
engine.throughput = 757.5 req/s | measured | api@4d03b9e2 ~release-branch | BRANCH-ONLY
engine.throughput = 16600 req/s | confirmed-by-human | human:sam | CONTESTED
```

Two answers. Both shown. Neither hidden.

The first is a **real measurement** that never shipped to your main branch. The second is **someone's
recollection**. Your agent can now tell those apart, and so can you. Most memory systems would have
returned one number with no idea which.

About **200 bytes** per answer, not twenty kilobytes. In our own benchmark Datum answered questions
using **31× less context** than stuffing your notes into the prompt — while being right more often.

## Why you'd want this

You ask an agent how fast your service is. It says **16,600 requests a second**, confidently, with a
citation.

That number was measured once, on a branch, months ago. It was corrected to 14,000 — and the
correction was written somewhere else. The old number appears in twenty-seven files. The correction
appears in one. Your agent found the *popular* answer, not the true one.

We measured this on a real project: **449 corrections scattered through 21,619 lines of notes, 34
copies of one facts file that disagreed with each other,** and the project's actual current target
appearing nowhere in its own knowledge base. Half of every agent session went on digging to find out
whether a claim was real.

Datum fixes it with four rules that are enforced by the database, not by good intentions:

**Every fact needs a receipt.** Where it came from, which commit, which instrument. No receipt, the
write is rejected — not warned about, rejected.

**Nothing is ever edited or deleted.** A correction is a *new* entry pointing at what it replaces.
The old number stays, marked dead, and can never come back as an answer.

**No agent can claim it measured something.** It can only say "unverified". A worker then checks
whether that commit exists and actually shipped. Only then does it become `measured`. Confidence is
earned, never typed.

**Disagreements are shown, not resolved for you.** Two sources conflict, you see both, flagged.
Quietly picking the newer one is how you end up confidently wrong.

## Run it in two commands

```bash
printf 'DATUM_ADMIN_PASSWORD=%s\nDATUM_SESSION_SECRET=%s\n' \
  "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" > .env
docker compose up
```

Open **http://localhost:8080/admin** and sign in with the password in your new `.env`. Your first API
key is printed once in the startup logs — paste it into the MCP config above.

Something to click through:

```bash
docker compose exec datum node packages/datum/dist/cli/index.js seed --example
```

There is no default password in this image. It refuses to start without one, deliberately.

## It also knows your code and your rules

**Ask what breaks before you change it:**

```
$ datum impact parse_config
parse_config  src/config.rs:10
  boot       src/main.rs:5     via calls
  serve      src/main.rs:30    via calls
  covered by tests: test_boot
```

Unlike a text search it can also tell you that **nothing** calls something — the answer you need
before deleting it. Head-to-head on a real 966-file codebase: right **97.5%** of the time against
grep's 81.5%, and grep confidently named the wrong thing **54%** of the time against Datum's **3.8%**.

**Which of your rules are real.** Datum reads your CI config, linter settings and branch protection
and works out which rules are actually *enforced* versus merely written down. On the project we
tested: 113 real rules, and **957 pieces of documented policy that nothing anywhere enforces.**

**What you keep asking for.** Correct the same thing in two different sessions and it remembers. A
second colleague asking independently makes it a team preference; a third makes it an org rule,
delivered to every agent before it starts work. It counts *occasions*, never words — so saying it
five times in one sitting counts once, which is how it avoids the bug that filled a competitor's
database with 808 copies of one thing nobody ever said.

## We publish the losses

- Against "put all your notes in the prompt" and "just use grep", Datum wins by **12 points** — but
  only once allowed to fall back to searching your notes. On its curated facts alone it wins by 6,
  which **fails** the bar we set ourselves.
- Its code understanding comes from a parser, not a compiler, so those facts are labelled `derived`
  and are not allowed to satisfy a strict check. We also found that label is **not independently
  auditable**, and said so.
- It never invents facts from prose. That's the point, and it's also why it will say "not on record"
  more often than something that guesses.

[`reports/m2-rerun.md`](reports/m2-rerun.md) · [`reports/impact-benchmark.md`](reports/impact-benchmark.md) · [`reports/restore-drill.md`](reports/restore-drill.md)

## Anywhere it runs

Postgres 13+, one process, migrations apply themselves on boot.

```bash
docker compose up                  # any machine with Docker
fly launch --from <this repo>      # Fly has no one-click button; this is the real command
```

No telemetry, no licence check, no phone-home. The only outbound call it can make is to GitHub, and
only if you give it a token so it can verify commits.

## Developing

```bash
npm install
npm test          # starts a real Postgres in Docker; nothing is mocked
```

Every rule is tested by breaking it — we drop each constraint and prove the test then fails, because
a test that passes without its constraint tests nothing.

[`HANDOFF.md`](HANDOFF.md) for the design · [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for running it

## Not yet

Slack and Linear digests, embeddings, multi-tenant auth. Multi-tenancy will live in a separate repo
that depends on this one — there are no locked features, upsells or `if (license)` branches in here,
and there never will be.

## License

Apache-2.0 · Copyright Aeonmind AI

<p align="center"><img src="assets/logo.svg" width="40" alt=""></p>
