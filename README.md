<p align="center">
  <img src="assets/banner.svg" alt="Datum — the datum of record" width="820">
</p>

<p align="center">
  <strong>Give your AI agents a memory that cannot make things up.</strong><br>
  Apache-2.0 · self-hostable · runs on Postgres · <a href="https://datum.aeonmind.ai">datum.aeonmind.ai</a>
</p>

---

## The problem

You ask an agent how fast your service is. It tells you **16,600 requests a second**, confidently,
with a citation.

That number was measured once, on a branch, months ago. It was corrected to 14,000 and the
correction was written *somewhere else*. The old number appears in twenty-seven files. The
correction appears in one. Your agent found the popular answer, not the true one.

This is the normal failure of agent memory, and it is not a prompting problem. We measured it on a
real project: **449 corrections scattered through 21,619 lines of notes, 34 copies of one facts
file that disagreed with each other, and the project's actual current target appearing nowhere in
its own knowledge base.** Half of every agent session was spent digging to find out whether a claim
was real.

## What Datum does

It is a ledger for facts, run like a bank account rather than a wiki.

**Every fact needs a receipt.** Where it came from, which commit, which instrument. No receipt, the
write is rejected. Not warned about — rejected.

**Nothing is ever edited or deleted.** A correction is a *new* entry that points at what it
replaces. So the old number is still there, marked dead, and can never come back as an answer.

**No agent can claim something was measured.** It can only say "unverified". A worker then goes and
checks: does that commit exist, and did it actually ship? Only then does the fact become
`measured`. Confidence is earned, not typed.

**When two sources disagree, it says so.** Most memory systems silently keep whichever is newer.
Datum keeps both, flags them, and tells you they conflict — because quietly picking one is how you
end up confidently wrong.

## Plug it into your agent

Datum speaks **MCP**, so Claude, Cursor, and anything else that speaks it can use it directly. Six
tools, nothing to learn:

| tool | what your agent asks |
|---|---|
| `state` | what's true here right now? |
| `ask` | what is X? |
| `why` | how do you know that? |
| `assert` | record this fact |
| `supersede` | that was wrong, here's the correction |
| `nodes` | who else is working here? |

```json
{
  "mcpServers": {
    "datum": {
      "url": "https://your-datum-instance/mcp",
      "headers": { "Authorization": "Bearer dtm_live_..." }
    }
  }
}
```

Answers come back small and dense — a couple of hundred bytes, not twenty kilobytes — and every
line carries where the fact came from and how much to trust it:

```
engine.throughput = 757.5 req/s | measured | api@4d03b9e2 ~release-branch | BRANCH-ONLY
engine.throughput = 16600 req/s | confirmed-by-human | human:sam | CONTESTED
```

Two answers, both shown, neither hidden. The first is real but never shipped to main. The second is
someone's recollection. **Your agent now knows the difference, and so do you.**

## Try it in two commands

```bash
printf 'DATUM_ADMIN_PASSWORD=%s\nDATUM_SESSION_SECRET=%s\n' \
  "$(openssl rand -base64 18)" "$(openssl rand -hex 32)" > .env
docker compose up
```

Open **http://localhost:8080/admin**, sign in with the password in your new `.env`. Your first API
key is printed once in the startup logs.

Want something to click through?

```bash
docker compose exec datum node packages/datum/dist/cli/index.js seed --example
```

There is no default password in this image. It refuses to start without one, on purpose.

## What else it knows

**Your codebase.** Point it at a repo and ask what breaks if you change something:

```
$ datum impact parse_config
parse_config  src/config.rs:10
  boot       src/main.rs:5     via calls
  serve      src/main.rs:30    via calls
  covered by tests: test_boot
```

Unlike a text search, it can also tell you **nothing** calls something — which is the answer you
need before deleting it. In a head-to-head on a real 966-file codebase it was right 97.5% of the
time against grep's 81.5%, and — the number that matters — **grep confidently named the wrong thing
54% of the time. Datum, 3.8%.**

**Your team's actual rules.** It reads your CI config, your linter settings and your branch
protection, and works out which rules are *enforced* versus merely written down. On the project we
tested it found 113 real rules — and **957 pieces of documented policy that nothing anywhere
enforces.**

**What you keep asking for.** If you correct the same thing across two different sessions, it
remembers. If a second colleague independently asks for the same thing, it becomes a team
preference; a third makes it an org rule, delivered to every agent before it starts work. It counts
*occasions*, never words, so saying it five times in one sitting counts once — which is how it
avoids the failure that filled a competitor's database with 808 copies of one thing nobody ever
said.

## Honest about what it isn't

We benchmark this against the boring alternatives and publish the losses.

- Against "just put all your notes in the prompt" and "just use grep", Datum wins by **12 points**
  — but only once it is allowed to fall back to searching your notes. On its curated facts alone it
  wins by 6, which **fails** the bar we set ourselves. That's in
  [`reports/`](reports/), including the run where it lost.
- Its code understanding comes from a parser, not a compiler, so it labels those facts `derived`
  rather than `measured` and will not let them satisfy a strict check.
- It never invents facts from prose. That's the point, and it is also the reason it will say "not on
  record" more often than a system that guesses.

Full numbers, methods and failures: [`reports/m2-benchmark.md`](reports/m2-benchmark.md),
[`reports/impact-benchmark.md`](reports/impact-benchmark.md),
[`reports/restore-drill.md`](reports/restore-drill.md).

## Run it anywhere

Postgres 13 or newer, and one process. Migrations run themselves on boot.

```bash
docker compose up                  # any machine with Docker
fly launch --from <this repo>      # Fly has no one-click button; this is the real command
```

No telemetry. No licence check. No phone-home. The only outbound request it can make is to GitHub,
and only if you give it a token so it can verify commits.

## For developers

```bash
npm install
npm test          # starts a real Postgres in Docker; nothing is mocked
```

Every rule is tested by breaking it: we drop each constraint and prove the test then fails, because
a test that passes without its constraint tests nothing.

Design and evidence: [`HANDOFF.md`](HANDOFF.md) · Operations: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

## Not yet

Projections to Slack and Linear, embeddings, multi-tenant auth. Multi-tenancy will live in a
separate repo that depends on this one — there are no locked features, upsells or `if (license)`
branches in here, and there never will be.

## License

Apache-2.0. Copyright Aeonmind AI.
