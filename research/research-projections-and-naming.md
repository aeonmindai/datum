# Research: Projections, Ops & Naming

Slice: `projections-and-naming`. Compiled 2026-08-24. Every claim carries a URL. Where a number could not be established from a primary source, it says so.

**Source-quality warning up front:** Part 1 (projections) is almost entirely primary — vendor API reference docs, error-code tables, and RFCs. Part 2A (hosting cost) is *not*: the vendors bury or paywall current pricing, and much of what follows is third-party blog aggregation. Those numbers are marked and should be re-verified against the vendor's own pricing page before anyone commits a budget.

---

## What exists

### Linear — GraphQL API, for a bot maintaining issues from an external source of truth

**Rate limits** ([linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting)):

| Auth | Requests/hr | Complexity points/hr | Scope |
|---|---|---|---|
| API key | 2,500 | 3,000,000 | per **user** (shared across all that user's keys) |
| OAuth app | 5,000 | 2,000,000 | per user (or app user) |
| Unauthenticated | 600 | 100,000 | per IP |

- Leaky-bucket refill at `LIMIT_AMOUNT / LIMIT_PERIOD`, not a per-hour cliff.
- **Max complexity of a single query: 10,000 points.** Exceed it and the query is always rejected.
- Complexity model: 0.1/property, 1/object, and **any connection multiplies its children by the pagination argument or the default 50**. Their worked example: fetching `id, title, createdAt` on `createdIssues` with default pagination = 66 points; with `first: 10` = 14 points. Not specifying `first` is a ~5x tax.
- Rate-limit errors return **HTTP 400** (not 429) with `extensions.code === "RATELIMITED"` in the GraphQL `errors` array.
- Headers: `X-RateLimit-Requests-{Limit,Remaining,Reset}`, `X-Complexity`, `X-RateLimit-Complexity-{Limit,Remaining,Reset}`, plus per-endpoint `X-RateLimit-Endpoint-*` for endpoints with their own lower limits.
- Limits are **dynamically increased** for workspace-level OAuth apps using Actor Authorization, scaled by paid seat count.

**Documentation defect:** the same page's prose says "When authenticated using an API key you can make up to **5,000** requests per hour", while the table immediately below says API key = **2,500**. Both on [linear.app/developers/rate-limiting](https://linear.app/developers/rate-limiting). Design against 2,500 and treat the headers as authoritative.

**Webhooks** ([linear.app/developers/webhooks](https://linear.app/developers/webhooks)):
- Delivery is a POST; consumer must return 200 within **5 seconds (5000ms)**.
- On failure: retried a **maximum of 3 times** with backoff at **1 minute, 1 hour, 6 hours**. "If the webhook URL continues to be unresponsive the webhook might be disabled by Linear, and must be re-enabled again manually."
- HMAC-SHA256 over the **raw** body in `Linear-Signature`; `Linear-Delivery` is a v4 UUID per payload; `webhookTimestamp` in the body. Linear explicitly recommends rejecting anything outside **60 seconds** of local time to defeat replay.
- Source IP allowlist published (9 addresses, e.g. `35.231.147.226`, `34.62.119.29`), "may occasionally update".
- Data-change events carry an **`actor`** field — `User`, OAuth client, or `Integration` — and `updatedFrom` containing the previous values of all updated properties. This is the loop-prevention primitive (see "What we should steal").
- Only **workspace admins, or OAuth applications with the `admin` scope**, can create or read webhooks.

**OAuth `actor=app` vs personal API keys** ([linear.app/developers/oauth-actor-authorization](https://linear.app/developers/oauth-actor-authorization), [linear.app/developers/agents](https://linear.app/developers/agents)):
- Default: the authenticating user is the actor; writes appear as that human.
- `actor=app` on the authorize URL makes the *app* the actor. Requires workspace **admin** to install. Supersedes the deprecated `actor=application`.
- `createAsUser` + `displayIconUrl` on `issueCreate`/`commentCreate` render as *"User (via Application)"* — lets you attribute a write to an external human who has no Linear account.
- Agent scopes: `app:assignable`, `app:mentionable`, `customer:read/write`, `initiative:read/write`. Assigning an issue to an app sets it as **`delegate`, not `assignee`**, so a human retains ownership.
- Agents installed in a workspace **do not count as billable users**.
- **Hard constraint:** "integrations using the `actor=app` mode are not able to also request `admin` scope."

**Token lifetimes** ([linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication)):
- All OAuth2 apps migrated to a **rotating** refresh-token system on 2026-04-01.
- Access token `expires_in: 86399` (**24h**); every refresh returns a **new** refresh token.
- **"Requests to consume a refresh token and obtain a new one have a 30-minute grace period to allow for network errors. If you make a request with a valid refresh token but do not receive the new one in the response, you can replay the original request to retrieve the new refresh token up to 30 minutes after the original request."**
- `client_credentials` grant exists for server-to-server, `expires_in: 2591999` (**~30 days**), **no refresh token** — on 401 you just mint a new one. Up to **1000 active client-credentials tokens in parallel, provided every token uses the same scopes.** Requesting a token with *different* scopes **revokes all existing `app` actor tokens**. Rotating the client secret also invalidates them all.

**Official Linear MCP server** ([linear.app/docs/mcp](https://linear.app/docs/mcp)):
- Streamable HTTP at `https://mcp.linear.app/mcp`; read-only variant at `/mcp/readonly`; `/sse` deprecated.
- Interactive setup uses **OAuth 2.1 with dynamic client registration**, but you *can* pass an API key or existing OAuth token directly as `Authorization: Bearer` — including **as an `app` user**. This is the only supported way to drive it non-interactively.
- Tools cover finding/creating/updating issues, projects, comments.
- **Cannot:** one auth session = one workspace (no multi-workspace switching without separate `MCP_REMOTE_CONFIG_DIR` contexts); no webhook management; no bulk/transactional writes; no bitemporal or historical query surface beyond what the GraphQL API exposes. Enterprise-managed auth is Okta-only.

**Agent session lifecycle** ([linear.app/developers/agents](https://linear.app/developers/agents)): delegation fires a `created` AgentSessionEvent; the agent **must emit a `thought` activity within 10 seconds** to acknowledge. Session state is derived from emitted activities, not manually managed. Developer Preview — "Functionality and Agent APIs may change before general availability."

### Discord — webhook, embed and thread limits

**Rate limits** ([docs.discord.com/developers/topics/rate-limits](https://docs.discord.com/developers/topics/rate-limits)):
- **Global: 50 requests/second per bot.** Independent of per-route limits. Unauthenticated requests are limited per-IP.
- Per-route limits are keyed by `X-RateLimit-Bucket`, and *scoped by top-level resource* — `channel_id`, `guild_id`, or **`webhook_id` / `webhook_id + webhook_token`**. Exhausting one channel's or webhook's bucket does not block another.
- `X-RateLimit-Scope` on a 429 is `user`, `global`, or `shared`.
- **Invalid Request Limit ("Cloudflare ban"): 10,000 invalid requests per 10 minutes per IP**, where invalid = 401, 403, or 429. That is a sustained 16–17 req/s of errors. 429s returned with `X-RateLimit-Scope: shared` are *not* counted.
- Discord explicitly says **"rate limits should not be hard coded into your app"** — parse the headers.
- Interaction endpoints are exempt from the global limit.
- A 404 from a webhook means stop using it: "repeated attempts to do so will result in a temporary restriction."

**Concrete caps, from Discord's own JSON error-code table** ([docs.discord.com/developers/topics/opcodes-and-status-codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes)) — this table is the authoritative source because the limit is printed in the error text:

| Code | Limit |
|---|---|
| 30007 | Maximum number of webhooks reached (**15**) — per channel |
| 30058 | Maximum number of webhooks per guild reached (**1000**) |
| 30013 | Maximum number of guild channels reached (**500**) |
| 30033 | Maximum number of thread participants (**1000**) |
| 30003 | Maximum pins per channel (**250**) |
| 30015 | Maximum attachments per message (**10**) |
| 30060 | Maximum channel permission overwrites (**1000**) |
| **30046** | **Maximum number of edits to messages older than 1 hour reached. Try again later** |
| 160006 | Maximum number of active threads reached — **no number given** |
| 40333 | Cloudflare is blocking your request — fix your User-Agent |

**Embed limits** ([docs.discord.com/developers/resources/message](https://docs.discord.com/developers/resources/message)): title 256, description 4096, ≤25 field objects, field.name 256, field.value 1024, footer.text 2048, author.name 256. **Combined sum of title + description + field.name + field.value + footer.text + author.name across all embeds on a message must not exceed 6000 characters.** Max **10** embeds per message. Violating any of these returns `Bad Request`. Embeds are **deduplicated by URL** — multiple embeds with the same URL render only the first. Message `content` is 2000 chars (4000 with Nitro, per [support.discord.com caps article](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More)).

**Threads** ([docs.discord.com/developers/topics/threads](https://docs.discord.com/developers/topics/threads)):
- `auto_archive_duration` ∈ {60, 1440, 4320, 10080} minutes.
- Webhooks post into threads via the `thread_id` query param; forum/media channels require `thread_id` **or** `thread_name`.
- Threads don't count against the 500-channel cap, but **"there is a limit on the maximum number of active threads in a guild"** — and the number is published nowhere.
- **"As a server approaches the max thread limit this timer will automatically lower, usually not below the `auto_archive_duration`. In very busy channels, threads set to a 7 day auto archive may archive earlier to help avoid the server becoming 'full'."**
- Archived threads are near-inert: cannot edit messages, add reactions, use application commands, or join. Sending a message auto-unarchives unless locked. Error 50083 covers operating on an archived thread.
- `SEND_MESSAGES` has **no effect** in threads; you need `SEND_MESSAGES_IN_THREADS`.

**Official server caps** ([support.discord.com/hc/en-us/articles/33694251638295](https://support.discord.com/hc/en-us/articles/33694251638295-Discord-Account-Caps-Server-Caps-and-More)): 500 channels (incl. voice/text/categories), 50 categories, 50 channels per category, 250 roles, 999 invite codes, 1000 members per thread, **audit log retention 45 days**. This article does **not** list the active-thread cap.

### GitHub — App patterns for watching many branches across many repos

**Rate limits** ([REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)):
- **GitHub App installation token: 5,000 req/hr minimum.** Scales: **+50/hr per repository above 20 repos**, and **+50/hr per user above 20 org users**. **Hard ceiling 12,500/hr** (GraphQL: same, 12,500 points/hr). GHEC installations start at 15,000/hr (GraphQL 10,000).
- `GITHUB_TOKEN` in Actions: 1,000/hr **per repository**.
- Unauthenticated: 60/hr. PAT / user-to-server: 5,000/hr, **pooled** — "if an app with a 15,000 request limit makes 10,000 requests on your behalf, you will have exhausted the 5,000 request budget for your personal access tokens".

**Secondary rate limits** — these, not the 5,000/hr headline, are what actually bites:
- **No more than 100 concurrent requests**, shared across REST and GraphQL.
- **≤900 points/min** to a single REST endpoint; **≤2,000 points/min** for GraphQL. Points: GET/HEAD/OPTIONS = 1, POST/PATCH/PUT/DELETE = **5**; GraphQL query = 1, GraphQL **mutation = 5**.
- **≤90 seconds of CPU time per 60 seconds of real time**, of which ≤60s may be GraphQL.
- **Content creation: ≤80 requests/minute and ≤500 requests/hour.** Counts UI actions *and* REST *and* GraphQL. "Some endpoints have lower content creation limits."
- **≤2,000 OAuth access token requests/hour** for GitHub Apps and OAuth apps.
- Advice: "pause at least 1 second between mutative requests and avoid concurrent requests." "Continuing to make requests while you are rate limited may result in the banning of your integration."

**GraphQL structural limits:** `first`/`last` mandatory on every connection, values 1–100, **≤500,000 total nodes per call**, and a hard **10-second server-side timeout** returning 502/504.

**Checks & Status APIs:**
- Check runs are **GitHub App-only for writes**; OAuth apps and users can read but not create ([docs.github.com/en/rest/checks/runs](https://docs.github.com/en/rest/checks/runs)).
- **"In a check suite, GitHub limits the number of check runs with the same name to 1000. Once these check runs exceed 1000, GitHub will start to automatically delete older check runs."**
- **Annotations: maximum 50 per API request.** More requires repeated Update calls, which append.
- Checks API "only looks for pushes in the repository where the check suite or check run were created. Pushes to a branch in a forked repository are not detected and return an empty `pull_requests` array."
- Commit statuses: **"there is a limit of 1000 statuses per sha and context within a repository. Attempts to create more than 1000 statuses will result in a validation error"** ([docs.github.com/en/rest/commits/statuses](https://docs.github.com/en/rest/commits/statuses)).

**Installation tokens** ([docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)):
- POST `/app/installations/{id}/access_tokens` with an app JWT. **Token expires after 1 hour.**
- Can be **down-scoped at mint time** by `repositories`/`repository_ids` (**up to 500 repositories**) and by `permissions` — never up-scoped beyond the installation grant. This is a genuine attenuation primitive.
- Since 2026-04-27 GitHub is rolling out a stateless `ghs_APPID_JWT` format; **anything assuming a 40-character token will break** ([github.blog changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header)).

**Webhooks** ([events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)):
- **Payload cap 25 MB. If an event generates a larger payload, GitHub does not deliver the event at all** — called out specifically for `create` "if many branches or tags are pushed at once."
- **`create` "event will not occur when more than three tags are created at once."**
- Respond 2xx within **10 seconds** or the delivery is a failure.
- `X-GitHub-Delivery` is **identical on redelivery** — so it is a correct idempotency key but *not* an attempt discriminator.
- **`sender` can be the `ghost` user.** "Sometimes GitHub can't resolve a specific user... For some events, such as `check_run` and `check_suite`, this includes actions with no Git push or authenticated API actor... Don't assume `sender` always identifies the person who caused an event, and account for the `ghost` user in any security or business logic that relies on it."

### GitLab — the only vendor that shipped webhook recursion detection

Worth including because it is the one *primary-source* implementation of loop prevention, versus a pile of vendor content-marketing.

- GitLab hit webhook recursion in production and shipped detection: MR !75821 "Add Webhook recursion detection (step 1: logging)", merged, labelled `severity::2`, `bug::performance`, `reliability`, `security` ([gitlab.com/gitlab-org/gitlab/-/merge_requests/75821](https://gitlab.com/gitlab-org/gitlab/-/merge_requests/75821)).
- The shipped mechanism is a header: **`X-Gitlab-Event-UUID` — "Unique ID for non-recursive webhooks. Recursive webhooks (triggered by earlier webhooks) share the same value."** ([docs.gitlab.com/user/project/integrations/webhooks/](https://docs.gitlab.com/user/project/integrations/webhooks/)). Causal chains are therefore identifiable from a single header.
- GitLab also adopted the [Standard Webhooks](https://www.standardwebhooks.com/) spec: `webhook-id`, `webhook-timestamp`, `webhook-signature` = `v1,{base64}` HMAC-SHA256 over `"{message_id}.{timestamp}.{body}"`, with explicit guidance to validate recency against replay and to compare in constant time.
- Limits ([docs.gitlab.com/user/gitlab_com/](https://docs.gitlab.com/user/gitlab_com/)): **100 webhooks per project, 50 per group; payload max 25 MB; timeout 10 seconds.** Push events default to **3 branches or tags per push — beyond that no webhook fires for the entire push event** (`push_event_hooks_limit`).
- **"When the rate limit is reached, all webhooks in the namespace are temporarily disabled and automatically re-enabled in the next minute."** One noisy project silences the whole namespace.

### Two-way sync with an external system of record

I could not find a first-party engineering postmortem of a Linear/Jira bidirectional sync failure. What exists is almost entirely **content marketing by companies selling sync products** — Truto, Stacksync, Unito, Exalate, ZigiWave, Valence. Treat their causal claims as plausible and their prescriptions as self-interested.

The one non-marketing, mechanically precise description of the duplicate-generating failure is Valence's docs ([docs.valence.app/en/latest/guides/stop-infinite-loops.html](https://docs.valence.app/en/latest/guides/stop-infinite-loops.html)): you write to each system keyed by *that system's* identifier; a new record syncs outward and comes back carrying a new foreign identifier; the reverse upsert doesn't match, so it **inserts** — yielding two records on one side, one on the other, and the original orphaned, with every subsequent edit spawning more duplicates.

Named mitigations recurring across all of them: origin tagging, compare-before-write fingerprinting, field-level ownership (one side owns each field), delta-only writes, and a periodic cursor-based reconciliation sweep as a safety net ([Truto](https://truto.one/blog/the-architects-guide-to-bi-directional-api-sync-without-infinite-loops/), [Stacksync](https://www.stacksync.com/blog/the-engineering-challenges-of-bi-directional-sync-why-two-one-way-pipelines-fail)).

### Hosting options

**⚠ Sourcing caveat: most cost figures below come from third-party blogs, not vendor pricing pages.** Vendor-primary claims are marked **[primary]**.

**fly.io** — No subscription; pay-as-you-go [primary: [fly.io/docs/about/pricing/](https://fly.io/docs/about/pricing/)]. Shared-CPU machines from ~$0.0027/hr (~$5.70/mo for 1 GB); Managed Postgres $38/mo (Basic) → $1,922/mo (Performance); volumes $0.15/GB/mo billed **whether attached or not**; egress $0.02/GB NA/EU, $0.04 APAC, $0.12 Africa/India; dedicated IPv4 $2/mo ([northflank](https://northflank.com/blog/railway-vs-flyio), [fly.io/docs/about/cost-management/](https://fly.io/docs/about/cost-management/)). Permanent free tier removed in 2024. **Estimated floor ~$48/mo.**
Scale-to-zero via `auto_stop_machines`/`auto_start_machines` [primary: [fly.io/docs/launch/autostop-autostart/](https://fly.io/docs/launch/autostop-autostart/)]. Resume-from-suspend "a few hundred milliseconds"; cold start from stopped ~2s+ [primary: [fly.io/docs/reference/suspend-resume/](https://fly.io/docs/reference/suspend-resume/)]; community reports 3–5s typical, 9s for Spring Boot. **"After a Machine starts, there may be a short delay before all proxy nodes recognize that it is running; requests sent to the Machine might fail during this time"** [primary: [fly-proxy-autostop-autostart](https://fly.io/docs/reference/fly-proxy-autostop-autostart/)].
Regional reads: app inspects `FLY_REGION` vs `PRIMARY_REGION` and swaps connection strings — **application-level routing, not transparent** [primary: [multi-region-fly-replay blueprint](https://fly.io/docs/blueprints/multi-region-fly-replay/)]. "Using proxy port 5432 from every region is quite slow"; synchronous replication "doesn't work well on cross-geo clusters" [primary: [globally-distributed-postgres](https://fly.io/blog/globally-distributed-postgres/)].

**Supabase** — Free ($0, 500 MB DB, **auto-pauses after 1 week idle**), Pro $25/mo including a $10 compute credit that makes Micro effectively free; egress 250 GB then $0.09/GB; Edge Functions 2M invocations then $2/M; Realtime 5M messages then $2.50/M and 500 concurrent peak connections then $10/1,000. No per-seat fees. **Floor $25/mo** ([makerkit](https://makerkit.dev/blog/saas/supabase-pricing), [flexprice](https://flexprice.io/blog/supabase-pricing-breakdown)).
Edge Function cold start **42 ms average, P99 under 500 ms** as of July 2025, down from a 200–800 ms baseline [primary: [supabase.com/blog/persistent-storage-for-faster-edge-functions](https://supabase.com/blog/persistent-storage-for-faster-edge-functions)]. Postgres never scales to zero.
Read replicas with a geo-routing API load balancer for GET requests, **asynchronous** replication, ~100–150 ms latency reduction for EU/Asia users [primary: [supabase.com/docs/guides/platform/read-replicas](https://supabase.com/docs/guides/platform/read-replicas)].

**Cloudflare Workers + Durable Objects** — Workers Paid $5/mo (10M requests, 30M CPU-ms), then $0.30/M requests and $0.02/M CPU-ms. DO: 1M requests/mo and 400K GB-s included, then $0.15/M, billed on **wall-clock time while running or resident-but-unable-to-hibernate** [primary: [DO pricing partial](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/partials/durable-objects/durable-objects-pricing.mdx)]. Hyperdrive: no extra charge on Paid [primary: [hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/index.md)]. D1 $0.001/M reads, $1.00/M writes, no egress charge [primary: [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)]. **Floor $5/mo + external Postgres.**
Worker CPU: 10 ms/request Free; **30 s default on Paid, raisable to 5 minutes** via `limits.cpu_ms`; network wait doesn't count [primary: [higher CPU limits changelog](https://developers.cloudflare.com/changelog/post/2025-03-25-higher-cpu-limits/), [workers limits](https://developers.cloudflare.com/workers/platform/limits)]. Subrequests: the old 1,000 cap was replaced in Feb 2026 by **10,000 default on Paid, raisable to 10 million**; Free stays at 50 external / 1,000 internal [primary: [subrequests changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)].
DO hibernate after **10 seconds of inactivity**; wake adds ~50–100 ms [primary: [DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)].

**Railway** — No free tier since 2023; Hobby $5/mo + usage; Pro $20/mo **per seat** with $20 usage credit. CPU $20/vCPU/mo, RAM $10/GB/mo, volumes $0.15/GB/mo, egress $0.05/GB. Small API + Postgres realistically $15–30/mo ([makerkit](https://makerkit.dev/pricing-calculator/railway), [servercompass](https://servercompass.app/blog/railway-pricing-what-youll-actually-pay)). Persistent containers, no scale-to-zero. Provides PgBouncer [primary: [docs.railway.com/databases/postgresql-pgbouncer](https://docs.railway.com/databases/postgresql-pgbouncer)]. **Could not verify** any read-replica or regional-latency story.

**Render** — Starter web service $7/mo (512 MB/0.5 CPU); Postgres Basic-256mb $6/mo but only 256 MB RAM / 1 GB storage, with $20/mo Basic the minimum viable for production; storage $0.30/GB/mo. **April 2026 plan changes cut included egress hard: Hobby 100 GB → 5 GB, Pro 500 GB → 25 GB**, overage $0.15/GB ([bex.co](https://bex.co/blog/2026/08/21/renders-1-5b-valuation-metered-egress-bill), [getdeploying](https://getdeploying.com/render)). Seat fees dropped April 2026. **Floor $13–27/mo.** Free tier spins down after 15 min idle with 10–60 s cold starts and **deletes data after 30 days**. **Could not verify** whether paid tiers spin down, or any read-replica story, or any published postmortem 2024–2026.

**Cost floor summary** (single small always-on API + one small Postgres, ~50 GB egress):

| Provider | Monthly floor | Biggest hidden line item |
|---|---|---|
| Cloudflare Workers + DO | **$5** + external DB | DO wall-clock billing; external Postgres cost |
| Render | $13–27 | Egress allowance cut 20x in Apr 2026; no pooler |
| Railway | $18–53 | $20/seat on Pro; egress $0.05/GB |
| Supabase | **$25** | Realtime concurrent-connection metering |
| fly.io | ~$48 | Managed PG $38 floor; volumes billed unattached; $2 IPv4 |

### Auth for hundreds of ephemeral agents

**The refresh-token concurrency race.** Mechanism: N workers share one refresh token; the access token expires; all N POST the same RT; the first succeeds and invalidates RT1; the rest present an invalidated RT; the AS reads that as theft and revokes the family; **every worker loses access mid-job.**

**RFC 9700, OAuth 2.0 Security Best Current Practice** (published Jan 2025), §4.14.2 ([rfc-editor.org/rfc/rfc9700.html](https://www.rfc-editor.org/rfc/rfc9700.html)):

> "Authorization servers MUST utilize one of these methods to detect refresh token replay by malicious actors for public clients: **Sender-constrained refresh tokens** ... **Refresh token rotation**: the authorization server issues a new refresh token with every access token refresh response. The previous refresh token is invalidated... If a refresh token is compromised and subsequently used by both the attacker and the legitimate client, one of them will present an invalidated refresh token, which will inform the authorization server of the breach. **The authorization server cannot determine which party submitted the invalid refresh token, but it will revoke the active refresh token.** This stops the attack at the cost of forcing the legitimate client to obtain a fresh authorization grant."

OAuth 2.1 draft ([datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1/](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1/)) makes rotation-or-sender-constraining mandatory for public clients.

**Neither spec acknowledges legitimate concurrency.** Both assume a single-threaded client. "The authorization server cannot determine which party submitted the invalid refresh token" is precisely the sentence that condemns a well-behaved parallel agent fleet. This is a spec-vs-reality gap, and every mitigation is a vendor extension.

**Vendor behaviour:**

| Vendor | Rotation default | Grace window | URL |
|---|---|---|---|
| **Linear** | Rotating since 2026-04-01 | **30 minutes** replay of the original request | [linear.app/developers/oauth-2-0-authentication](https://linear.app/developers/oauth-2-0-authentication) |
| Okta | On by default for public clients | **30 s default, 0–60 s configurable** | [developer.okta.com/docs/guides/refresh-tokens/main/](https://developer.okta.com/docs/guides/refresh-tokens/main/) |
| Auth0 | Optional | "Rotation Overlap Period" in seconds; only the *previous* token is replayable, second-to-last triggers breach detection | [auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation) |
| Keycloak | Optional (`Revoke Refresh Token`) | None; `Refresh Token Max Reuse` counter only | [github.com/keycloak/keycloak/issues/16081](https://github.com/keycloak/keycloak/issues/16081) |
| Duende IdentityServer | **Reusable by default since v7.0** | `ConsumedTokenCleanupDelay` | [duendesoftware.com/blog/20240405-refresh-token-reuse](https://duendesoftware.com/blog/20240405-refresh-token-reuse) |
| Google | **Does not rotate** | n/a | [useparagon.com/blog/oauth-token-refresh-expiry-at-scale](https://www.useparagon.com/blog/oauth-token-refresh-expiry-at-scale) |

Duende — a major commercial IdP — **reversed its default**, stating rotation "is not usually helpful from a security point of view but is actively harmful to the user experience and produces greater load on the data store," and now recommends DPoP instead. Keycloak's implementation had **CVE-2026-1035**: validation and update were not atomic, letting concurrent requests bypass single-use enforcement (≤ v26.2.5) ([cvedetails](https://www.cvedetails.com/cve/CVE-2026-1035/)).

**This bug is endemic in the agent tooling we actually use:**
- Claude Code, 4–7+ concurrent sessions all lose auth simultaneously; shared `~/.claude/.credentials.json`, no file locking ([anthropics/claude-code#48786](https://github.com/anthropics/claude-code/issues/48786))
- MCP TypeScript SDK, no concurrency guard in `auth()` ([modelcontextprotocol/typescript-sdk#1760](https://github.com/modelcontextprotocol/typescript-sdk/issues/1760))
- OpenAI Codex, "your refresh token was already used" with multiple app-servers ([openai/codex#10332](https://github.com/openai/codex/issues/10332))
- Duende Support #966, eca #462, next-auth #3940 ([nextauthjs/next-auth#3940](https://github.com/nextauthjs/next-auth/discussions/3940))

**Workload identity alternatives:**
- **GitHub Actions OIDC** — issuer `https://token.actions.githubusercontent.com`; claims include `repository`, `repository_id`, `repository_owner_id`, `workflow_ref`, `job_workflow_ref`, `run_id`, `run_attempt`, `environment`, `actor`; customisable `sub`; repos created after 2026-07-15 get immutable owner/repo IDs in `sub`. Token is per-job and auto-expiring ([docs.github.com/.../about-security-hardening-with-openid-connect](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)).
- **AWS `AssumeRoleWithWebIdentity`** — `DurationSeconds` 900 s min, default 3600 s, up to the role's max session duration (1–**12 h**) ([AWS API ref](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html)).
- **GCP Workload Identity Federation** — STS token capped at **1 hour** regardless of input token `exp`; input must satisfy `exp - iat ≤ 24 h` ([cloud.google.com/iam/docs/workload-identity-federation](https://cloud.google.com/iam/docs/workload-identity-federation)).
- **Azure** — Azure Pipelines idToken **10 minutes**; AKS workload identity max **24 h**; max **20** federated identity credentials per app; only the **first 100** signing keys cached ([learn.microsoft.com/.../workload-identity-federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)).
- **SPIFFE/SPIRE** — X509-SVID default TTL **6 h**, JWT-SVID default **5 min**. The JWT-SVID spec is unusually candid: "Being a bearer token, JWT-SVIDs are susceptible to replay attacks... Tokens sent to one audience can be replayed to another audience should more than one be present... **Single audience JWT-SVID tokens are strongly recommended**" ([spiffe.io/docs/latest/spiffe-specs/jwt-svid/](https://spiffe.io/docs/latest/spiffe-specs/jwt-svid/)).
- **RFC 8693 Token Exchange** ([rfc-editor.org/rfc/rfc8693.html](https://www.rfc-editor.org/rfc/rfc8693.html)) — `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, with `subject_token`, `subject_token_type` (required), and optional `audience`, `scope`, `resource`, `requested_token_type`. The spec does not forbid issuing a refresh token but the normal output is a short-lived access token.
- **Sender-constraining** — RFC 8705 mTLS certificate-bound tokens via `cnf.x5t#S256` ([rfc-editor.org/rfc/rfc8705.html](https://www.rfc-editor.org/rfc/rfc8705.html)); RFC 9449 DPoP binds at the application layer via a per-request signed proof JWT ([rfc-editor.org/rfc/rfc9449.html](https://www.rfc-editor.org/rfc/rfc9449.html)). DPoP is the cheaper of the two — an ephemeral keypair per agent, no CA, no TLS termination control required.
- Revocation at scale: RFC 7662 introspection ([datatracker.ietf.org/doc/html/rfc7662](https://datatracker.ietf.org/doc/html/rfc7662)) trades statelessness for latency; the OAuth Status List draft offers bit-packed status ([draft-ietf-oauth-status-list-20](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-status-list-20)) but is not an RFC.

---

## What is proven vs claimed

**Proven — vendor-documented, numeric, and directly checkable:**
- Every rate limit, cap and character count in Part 1. Discord's error-code table is especially strong evidence because the limit is embedded in the error the server actually returns.
- GitHub's installation-token attenuation (down-scope by repo list and permission at mint time, ≤500 repos, 1 h expiry) is documented behaviour, not inference.
- GitHub's 25 MB payload drop and the "no `create` event for >3 tags at once" behaviour are documented, and both are *silent* failures.
- Linear's 30-minute refresh-token replay grace period is documented, exact, and is the largest such window found anywhere in this research.
- Linear's `client_credentials` semantics: ~30-day tokens, no refresh token, 1000 parallel tokens **same-scope only**, scope change revokes all.
- GitLab's `X-Gitlab-Event-UUID` recursion semantics, and the fact that GitLab shipped it in response to a real `severity::2` production problem.
- RFC 9700 §4.14.2's exact text, including the admission that the AS cannot distinguish attacker from legitimate client.
- Duende's public reversal of its rotation default; Okta's 30 s / 0–60 s grace window.
- Package-registry availability and domain registration in the naming section: I queried `registry.npmjs.org`, `pypi.org/pypi/*/json`, `crates.io/api/v1/crates/*`, Verisign RDAP and rdap.org directly. 404 = available.
- Trademark counts in Nice classes 9/42 across the US and EU offices: queried TMview (`tmdn.org/tmview/api/search/results`) filtered to `fOffices:[US,EM]`, `fNiceClass:[9,42]`, `fTMStatus:[Filed,Registered]`.
- Supabase's Feb 12 2026 outage is a first-party postmortem with root cause and duration.

**Claimed, weakly sourced, or vapour:**
- **Nearly all hosting prices.** Fly's, Railway's and Render's actual current numbers came via kuberns/makerkit/northflank/bex.co/servercompass, not vendor pricing pages. Several are affiliate-flavoured comparison content. Re-verify before budgeting.
- **The entire two-way-sync literature.** Truto, Stacksync, Unito, Exalate, ZigiWave all sell sync products and all describe the infinite-loop problem in terms that make their product the answer. No first-party postmortem was found.
- **"Discord's active thread cap is 1,000."** Asserted by a marketing blog ([metacrm](https://www.metacrm.inc/blog/full-guide-to-discord-s-channel-limit-overall-server-caps)). Discord's API docs confirm a cap *exists* and error 160006 exists, and Discord's own official caps article omits it entirely. **Unverified.**
- Fly "Postgres cluster down for 3 days" — a Hacker News comment ([news.ycombinator.com/item?id=36808296](https://news.ycombinator.com/item?id=36808296)), not a postmortem.
- Cloudflare DO latency figures (1–5 ms same-region, 50–150 ms cross-continent, 150–200 ms for the São Paulo→London pinned-object case) come from a third-party book site ([architectingoncloudflare.com/chapter-06/](https://architectingoncloudflare.com/chapter-06/)), not Cloudflare. The *architectural* claim they illustrate — objects never migrate — is primary.
- Render: no postmortems, no read-replica docs, no paid-tier spin-down answer found. Genuinely opaque.
- Linear's Agent APIs are an explicitly labelled **Developer Preview** subject to change.
- USPTO and EUIPO direct search UIs blocked automated access; TMview is a federated aggregator of those registries and is good evidence of *presence*, but a zero result is not a clearance opinion. **No name here has been cleared by counsel.**

---

## Where it breaks / what it cannot do

**Linear**
- **`actor=app` cannot hold `admin` scope, and `admin` is required to create or read webhooks via the API.** So an agent app can never programmatically manage its own webhook subscriptions. The only path is app-level webhook configuration in developer settings, where Linear auto-creates a webhook per authorizing org. Any design assuming "the agent provisions its own webhook" is dead on arrival.
- 2,500 req/hr per **user** for API keys, pooled across all that user's keys — you cannot buy headroom by minting more keys. Hundreds of agents behind one Linear identity share one bucket.
- 10,000-point single-query ceiling plus the ×50 default-pagination multiplier means naive nested queries fail outright rather than degrading.
- Rate limiting arrives as HTTP **400**, so any client treating non-429 4xx as permanent will discard retryable failures.
- 5-second webhook timeout, only 3 retries, and the last is 6 hours later. Miss all four and the event is gone — with **auto-disable** if you stay unhealthy. There is no replay/backfill API for missed webhooks.
- `client_credentials`: requesting a token with different scopes **revokes every existing app token**. A single mis-scoped deploy kills every running agent. This is structurally the same class of bug that has already burned us twice.
- MCP server is one-workspace-per-auth-session and offers no bitemporal, bulk, or transactional surface.

**Discord**
- 50 req/s globally per bot is the wall. Hundreds of agents posting directly will hit it; the *only* escape is that per-route buckets are keyed by `webhook_id`, so fanning across many webhooks partitions the per-route limit — **but the 50/s global still applies to everything sharing that bot token.**
- 15 webhooks per channel / 1000 per guild / 500 channels means **per-agent channels or per-agent webhooks do not scale to hundreds** without careful reuse.
- **Error 30046 — "Maximum number of edits to messages older than 1 hour"** — kills the obvious "maintain one live status message and keep editing it" projection. A long-running mission dashboard *will* hit this.
- The active-thread cap is real, undocumented, and **enforced by silently shortening auto-archive**: "threads set to a 7 day auto archive may archive earlier to help avoid the server becoming 'full'". You cannot design against an unpublished limit whose enforcement mechanism is silent data disappearance. Archived threads then reject writes (error 50083).
- 6000-character total embed budget and 25 fields per embed: a provenance-rich fact record does not fit. Anything real needs a link out.
- Audit log retention **45 days**. Discord is not an archive.
- 10,000 invalid requests / 10 min → IP-level Cloudflare ban. A crash-looping fleet with a stale token (401s) bans the whole egress IP.

**GitHub**
- **The binding limit is content creation: 80/min and 500/hr**, not 5,000/hr. Check runs, statuses, comments and annotations are content. A fleet watching many branches across many repos will hit 500/hr long before the primary limit — and the counter includes human UI actions in the same org.
- **100 concurrent requests shared across REST and GraphQL**, org-wide for the installation.
- Mutations cost 5 points against the 900/min-per-endpoint and 2,000/min GraphQL secondary limits, so a burst of check-run updates is 5x more expensive than it looks.
- The installation ceiling is **12,500/hr and does not grow past it**, no matter how many repos you add. Growth in repos eventually stops buying quota.
- **Silent event loss:** payloads >25 MB are never delivered, and `create` doesn't fire at all for >3 simultaneous tags. Pushing many branches or tags at once — exactly what a worktree-per-agent system does — is the documented trigger. A branch-watching design built purely on webhooks **will** miss events, so reconciliation is mandatory, not optional.
- `X-GitHub-Delivery` is stable across redeliveries: good idempotency key, useless for distinguishing attempts.
- **`sender` can be `ghost`** on `check_run`/`check_suite`. Any provenance or loop-detection logic keyed on `sender` has a hole GitHub explicitly warns about.
- 1000 check runs per name per suite (auto-deleted beyond), 1000 statuses per sha+context (hard validation error), 50 annotations per request.
- Forked-repo pushes are invisible to the Checks API.
- The `ghs_APPID_JWT` token-format rollout breaks any 40-char assumption.

**Hosting**
- **Cloudflare Durable Objects are single-homed for life.** "Durable Objects do not currently change locations after creation" [primary: [data-location](https://developers.cloudflare.com/durable-objects/reference/data-location/)]; location hints are approximate. Cloudflare's own launch post concedes the fundamental limit: "Transactions inherently must be coordinated in a single location; clients on the opposite side of the world from that location will experience moderate latency due to the speed of light" ([blog.cloudflare.com/introducing-workers-durable-objects/](https://blog.cloudflare.com/introducing-workers-durable-objects/)). For a globally-distributed agent fleet writing to one authoritative log, whichever region created the object wins forever. Each DO is also single-threaded, capping per-object write throughput — and an append-only fact log is exactly the shape that wants one hot object.
- DO storage caps at **10 GB per object** and **write operations fail** at the cap [primary: [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits)]. An append-only store that never deletes will reach it; the design must shard from day one.
- DO billing is **wall-clock while resident**, and hibernation requires no timers, no in-flight fetch, and no standard-WebSocket usage — precisely the things an event-fanout service does. Hibernation also **only** works for *incoming* sockets accepted via `ctx.acceptWebSocket()`, not outgoing connections to Linear/Discord/GitHub ([workerd#4864](https://github.com/cloudflare/workerd/issues/4864)).
- Hyperdrive pools ~20 connections Free / ~100 Paid, a soft limit it "will temporarily exceed" ([CF limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)).
- **Supabase transaction-mode pooling (port 6543) has no prepared statements and no LISTEN/NOTIFY** [primary: [prisma troubleshooting](https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting), [disabling prepared statements](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)]. If the event-fanout design leans on LISTEN/NOTIFY it must use session mode, which then caps concurrency — total connections across both modes ≤30 on default tiers [primary: [connecting-to-postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)]. Hundreds of ephemeral agents opening short-lived connections is the worst case for this.
- **Fly's unmanaged Postgres is not a managed database** — "it's a regular app you deploy", Fly is "not able to provide support or guidance for unmanaged Postgres", and "SSD failure means you lose any data since last snapshot" [primary: [what-you-should-know](https://fly.io/docs/postgres/getting-started/what-you-should-know/), [HA guide](https://fly.io/docs/postgres/advanced-guides/high-availability-and-global-replication/), [fly.io/docs/postgres/](https://fly.io/docs/postgres/)]. Managed Postgres is the real product and starts at $38/mo; even it saw leadership churn from ORD transit packet loss on 2026-06-11 [primary: [fly.io/infra-log/](https://fly.io/infra-log/)].
- **Render ships no connection pooler at any tier** ([kuberns](https://kuberns.com/blogs/render-postgres-pricing-setup-limits/)) and no PITR below Standard. For hundreds of short-lived connections that is disqualifying without an external PgBouncer.
- **Railway's blast radius is the platform.** 8-hour platform-wide outage on 2026-05-19/20 because **Google Cloud suspended Railway's production account** [primary: [blog.railway.com](https://blog.railway.com/p/incident-report-may-19-2026-gcp-account-outage)]; a Dec 2025 cryptominer via a Next.js vuln caused fleet-wide CPU starvation; and — bleakly apt — a **Nov 2025 outage caused by a surge in GitHub webhook events overwhelming their deployment queue** ([northflank](https://northflank.com/blog/railway-app-outage)). Railway's own Feb 2026 reflection names "tightly coupled systems with a large blast radius".
- Everyone has a single-region correlated-failure story: Supabase us-east-2 down 3 h 42 m from a config change that enabled AWS VPC Block Public Access region-wide [primary: [supabase postmortem](https://supabase.com/blog/supabase-incident-on-february-12-2026)]; Cloudflare Workers KV down 148 min due to a third-party provider [primary: [blog.cloudflare.com](https://blog.cloudflare.com/rearchitecting-workers-kv-for-redundancy/)], plus the Nov 2025 global Bot Management outage and the Mar 2025 R2 credential-rotation error (an engineer omitted `--env production`).

**Auth**
- The specs are actively hostile to our topology. RFC 9700 mandates rotation-or-sender-constraining for public clients and describes family revocation as the *correct* response to what our fleet does normally. There is no spec-blessed way to have N concurrent workers share a rotating refresh token.
- Grace windows are the only real mitigation, and they are non-standard, per-vendor, and short: Okta 30 s, Auth0 "previous token only". Linear's 30 minutes is a generous outlier we cannot assume elsewhere.
- Keycloak's CVE-2026-1035 shows even the atomicity of single-use enforcement is not reliable.
- Stateless JWTs plus short TTL means **no real revocation**. Introspection (RFC 7662) restores it at the cost of the statelessness that made it scale. OAuth Status List is a draft.
- Workload identity is not universal: it requires the platform to be an OIDC issuer. Agents on a developer laptop or a bare VM have no attestation, so a fallback credential path is unavoidable — and that fallback is where the refresh-token race comes back.
- Azure caps federated identity credentials at 20 per app and caches only the first 100 signing keys — a hard multi-tenant ceiling.
- JWT-SVIDs are replayable across audiences by design; SPIFFE says so out loud.

---

## What we should steal

1. **GitLab's `X-Gitlab-Event-UUID` causality header, verbatim in concept.** A single ID that is fresh for an externally-caused event and *inherited* by everything that event causes gives you loop detection, causal chains, and blast-radius attribution from one field. This is the mechanism a bitemporal event log wants anyway, and it is the only shipped, primary-sourced solution to webhook recursion found in this research.

2. **Linear's `actor` + `updatedFrom` webhook shape.** Every change event names who caused it (User / OAuth client / Integration) and carries the previous values of every changed property. That is origin tagging and a delta in the payload — enough to ignore your own echoes and to write a superseding record without a read-back. Our event log should emit exactly this.

3. **Linear's 30-minute refresh replay grace, and its `client_credentials` no-refresh-token path.** Adopt both: if we ever issue rotating credentials, an idempotent replay window measured in minutes (not Okta's 30 seconds) is the difference between a fleet that survives a network blip and one that dies. Better, follow Linear's own server-to-server answer — a ~30-day token with **no refresh token at all**, where a 401 simply means mint a new one.

4. **GitHub's installation-token attenuation.** Mint-time down-scoping by explicit resource list and permission set, never up-scopable beyond the parent grant, with a 1-hour expiry. This is exactly the right shape for per-agent, per-mission credentials: one long-lived org grant, N attenuated short-lived derivations. Steal the model wholesale.

5. **Standard Webhooks signing, as GitLab adopted it.** `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,{base64}` HMAC-SHA256 over `"{id}.{timestamp}.{body}"`, constant-time compare, reject stale timestamps. Versioned signature prefix and a list-valued header make key rotation possible without downtime. Don't invent a signing scheme.

6. **RFC 8693 token exchange as the front door for agents.** `subject_token` = platform OIDC assertion, out comes a short-lived, single-audience, scope-restricted token. No refresh token, therefore no rotation, therefore no race. Pair with single-audience tokens per SPIFFE's explicit warning.

7. **Complexity-based rate limiting with the cost exposed in a response header.** Linear returns `X-Complexity` on every request and charges connections by their pagination argument. Clients can self-regulate because they can see the price. If we sell this, per-request cost transparency is table stakes.

8. **Down-scoped read endpoints as a first-class product surface**, per Linear's `/mcp/readonly` and read-only-scope duality: a URL that *cannot* write, plus a token that cannot write. Two independent mechanisms for the same guarantee.

9. **Discord's error-code-carries-the-limit convention.** `30007 Maximum number of webhooks reached (15)`. Putting the numeric limit in the error text is why Discord's caps are the best-documented in this research despite their docs omitting them. Cheap, and it makes clients self-correcting.

## What we should deliberately do differently, and why

1. **Never share a rotating refresh token across agents. Never issue refresh tokens to agents at all.** RFC 9700 §4.14.2 concedes the AS "cannot determine which party submitted the invalid refresh token", so correct spec-compliant behaviour is to kill our whole fleet. Our design: one org-level grant; each agent presents a platform OIDC assertion and receives a 5–15 minute, single-audience, scope- and mission-bound access token via RFC 8693. Expiry replaces revocation. This is also why Duende reversed its default and why Google never rotated — and it is the direct fix for the failure that killed our job twice.

2. **Treat every projection target as lossy and make reconciliation primary, not a safety net.** GitHub silently drops >25 MB payloads and fires no `create` at all for >3 simultaneous tags; Linear gives up after 3 retries and may auto-disable the webhook; GitLab disables an entire namespace's webhooks when one project is noisy; Discord silently archives threads under pressure. Every one of these is *silent*. A cursor-based sweep over our own event log must be the source of convergence, with webhooks as a latency optimisation only. The vendor blogs call reconciliation a "safety net" every 15 minutes; that framing is backwards for a system whose whole value proposition is that facts are not lost.

3. **Never key loop detection or provenance on the actor field alone.** GitHub explicitly warns `sender` may be the `ghost` user on exactly the `check_run`/`check_suite` events a branch-watcher cares about. Provenance must be established by *our* causality ID travelling with the write, not by trusting the downstream system to tell us who did it. This is why mandatory provenance has to be enforced at our write boundary rather than reconstructed from projections.

4. **Do not build the authoritative log on Cloudflare Durable Objects.** A DO never migrates after creation, is single-threaded, caps at 10 GB per object with hard write failure at the cap, and cannot hibernate while doing outbound fanout — so we would pay wall-clock for the privilege. An append-only bitemporal store that never deletes and is written by agents on several continents is the worst possible fit. Postgres for the log; consider Workers/DO only for edge read caching and websocket fanout, where single-homing is cheap.

5. **Do not put the projection layer on the same platform as the store, and prefer boring Postgres over the cheapest floor.** Railway went down for 8 hours because *Google suspended their account*, and separately fell over because of a surge of GitHub webhooks — literally our workload. Supabase lost a whole region for 3h42m to its own config change. The $5 Cloudflare floor and the $25 Supabase floor are real, but Supabase's ≤30 pooled connections and transaction-mode loss of LISTEN/NOTIFY collide head-on with hundreds of ephemeral connections. Fly's managed Postgres at $38 buys an actual managed database — and Fly's own docs are refreshingly explicit that the *unmanaged* one will lose data on SSD failure.

6. **Never maintain state by editing a Discord message.** Error 30046 caps edits to messages older than an hour, so the natural "live mission dashboard" pattern degrades exactly when a mission gets long. Post immutable, append-only events; let humans read a chronology. This happens to be the same discipline as the fact store, which is the point: the projection should inherit the log's semantics rather than fight them.

7. **Budget GitHub against 500 content-creating requests/hour, not 5,000 requests/hour**, and make check-run/status writes coalescing and mission-scoped rather than per-agent-per-branch. The 12,500/hr ceiling never rises, the 80/min and 500/hr content limits include humans clicking in the same org, and mutations cost 5 points each. Aggregate per mission, one check run per mission with ≤50 annotations per update.

8. **Do not attempt two-way sync with Linear or anything else.** The whole documented failure class — duplicate storms, orphaned originals, ping-ponging status — arises the instant two systems can both write the same field. Our architecture already says projections are downstream and the log is the source of truth; hold that line absolutely, including for the tempting cases (someone edits an issue title in Linear). Field-level ownership, one direction, human edits in projections are *input events* to the log, never authoritative state. Note that the entire literature recommending clever bidirectional machinery is written by vendors selling bidirectional machinery.

9. **Publish numeric limits in error messages and expose request cost in headers.** Discord's undocumented active-thread cap is the cautionary case: a real limit, silently enforced by discarding user data, findable nowhere. If we sell this to other teams, every limit we enforce must be discoverable from a response.

---

## NAMING

Method: for each candidate I queried `registry.npmjs.org/<name>`, `pypi.org/pypi/<name>/json`, and `crates.io/api/v1/crates/<name>` (404 = available); Verisign RDAP (`rdap.verisign.com/com/v1/domain/<name>.com`) and `rdap.org` for `.ai` registration; and TMview (`tmdn.org/tmview/api/search/results`) filtered to offices US + EUIPO, Nice classes **9 and 42**, status Filed or Registered. Company collisions via web search.

Two caveats. **crates.io returns 403 without a User-Agent header** — an earlier pass reported every crate as unverifiable purely because of that; with a UA all resolved cleanly. And **a zero TMview result is evidence of absence in classes 9/42 in two offices, not a clearance opinion.** Nothing here has been cleared by counsel.

### The ten given candidates

| Name | npm | PyPI | crates | .com | .ai | TM in cl 9/42 (US+EU) | Verdict |
|---|---|---|---|---|---|---|---|
| Callosum | taken (2013, dead) | taken (2024, active) | taken (2025) | reg. 2002 | reg. 2024 | **2** incl. Rolls Royce Power Systems AG (cl 7,9,37,41,42) | **HIGH** |
| Engram | taken (2014, dead) | taken (2026, active) | taken (57,975 dl) | reg. 1996 | reg. 2018 | **13** incl. MEMORIOUS INC (cl 9), Flagship Labs 119 (cl 42), Engram Health | **HIGH** |
| Claustrum | taken (2026, active) | taken (placeholder) | **free** | reg. 2000 | reg. 2025 | **3** incl. **CLAUSTRUM AI (Life2, Inc.)** | **MEDIUM-HIGH** |
| Thalamus | taken (2026, active) | taken (2026, active) | taken (2023) | reg. 1998 | reg. 2017 | **4** incl. SJ Medconnect (= ThalamusGME), Thalamus S.A. | **HIGH** |
| Ganglion | taken (2015, dead) | taken (2025) | taken (21 dl) | reg. 2000 | reg. 2023 | **1**, and it is "Ganglionorm" — not a real conflict | **LOW-MEDIUM** |
| Noosphere | taken (2026, active) | **free** | taken (57,459 dl) | reg. 1999 | reg. 2017 | **8** incl. Noosphere Labs, 410 Labs, PIPL | **MEDIUM-HIGH** |
| Anamnesis | taken (2020) | taken (2022) | taken (2026, active) | reg. 1999 | reg. 2023 | **4** incl. Square Enix, Anamnesis LLC | **MEDIUM** |
| Continuum | taken (2013, dead) | taken (2023, active) | taken (2026) | reg. — | reg. — | **106** | **DISQUALIFIED** |
| Praxis | taken (2015, dead) | taken (2024, Google's `praxis`) | taken (2025) | reg. 1996 | reg. 2017 | **127** | **DISQUALIFIED** |
| Substrate | taken (2024, Substrate Labs SDK) | taken (2024, Substrate Labs SDK) | taken (2018) | reg. 1997 | reg. 2017 | **24** incl. **Epic Games, Inc.** | **DISQUALIFIED** |

Company collisions worth naming explicitly, all verified:
- **Callosum** — a UK AI-infrastructure startup raised **$100M seed** in Aug 2026 (Atomico/Plural/DCVC) for heterogeneous AI compute orchestration ([atomico.com](https://atomico.com/insights/our-investment-in-callosum-building-the-layer-that-makes-ai-compute-work)). Adjacent enough to be genuinely confusing, plus Rolls Royce holds the mark in classes 9 and 42.
- **Engram** — an SF **AI-memory** startup raised **$98M** in June 2026 at a $600M valuation (Sequoia/Kleiner/Karpathy) ([CNBC](https://www.cnbc.com/2026/06/23/ai-memory-startup-focused-on-cutting-token-costs-raises-98-million.html)). This is our exact category. The TMview hit "ENGRAM — MEMORIOUS, INC. — class 9" is almost certainly them. Unusable.
- **Thalamus** — ThalamusGME, medical residency interview platform, 800+ institutions, AAMC partnership ([thalamusgme.com](https://www.thalamusgme.com)). Also GNU Health's federation server and thalamus.ai consulting.
- **Continuum** — Continuum Analytics became **Anaconda** ([wikipedia](https://en.wikipedia.org/wiki/Anaconda_(Python_distribution))); plus Continuum Industries in AI infra. 106 marks confirms it is effectively a generic.
- **Praxis** — **Google's own `praxis` neural-network library** ([github.com/google/praxis](https://github.com/google/praxis), on PyPI), plus Praxis AI in education. The earlier research pass called Praxis "LOW risk"; **127 live marks in classes 9/42 says otherwise.** Corrected.
- **Substrate** — three separate majors: substrate.run (Substrate Labs, $8M seed, compound-AI workflow execution), substrate.com (semiconductor foundry), substrate.ai (EU sovereign AI). Epic Games holds a mark. Hopeless.
- **Noosphere** — Noosphere Ventures / blockchain-as-a-service ([en.noosphere.net](https://en.noosphere.net)), and an active AI npm package.
- **Claustrum** — Claustrum AI by Life2, healthcare outcome optimisation ([life2inc.com/claustrum-ai/](https://www.life2inc.com/claustrum-ai/)), holding a mark in our classes.
- **Anamnesis** — Anamnèse, Paris, medical AI for patient history ([anamnese.care](https://www.anamnese.care)).

### Five further candidates of my own

Brief: *"a shared nervous system that lets any number of agents across any number of projects know the same facts, the current mission, and each other."* The white-matter **tract** is the right metaphor — not the memory organ (crowded, and Engram owns it) but the *bundle that carries shared state between hemispheres*.

I investigated eight and am reporting five. **Three were eliminated outright and the reason matters:**
- **Astrocyte** — `github.com/AstrocyteAI/astrocyte`, tagline **"Memory for every agent"**, an open-source memory framework sitting between agents and memory storage. Our exact pitch, already shipped. Dead.
- **Mnemon** — `github.com/mnemon-dev/mnemon`, "LLM-supervised persistent memory for AI agents — graph-based recall, cross-session knowledge", plus a second unrelated `mnemon` MCP memory server. Dead.
- **Consilium** — **8 marks in classes 9/42**, including Consilium Marine & Safety AB with registrations spanning cl 9, 37, 40, 42, plus Consilium Software (Singapore, since 2007). Dead.

The five reportable:

| Name | npm | PyPI | crates | .com | TM cl 9/42 | Notes |
|---|---|---|---|---|---|---|
| **Commissure** | **free** | **free** | **free** | reg. 2004, **expires 2026-11-06** | **0** | Only ever collision: Commissure Inc., medical imaging, **acquired by Nuance in Sept 2007** ([PitchBook](https://pitchbook.com/profiles/company/125771-77)) — dormant as a brand for 19 years. `.ai` registered 2026-05-05. |
| **Colliculus** | **free** | **free** | **free** | registered | **0** | No company collision found. Clean but a mouthful; awkward to say and to spell. |
| **Syncytium** | taken (2026-03) | taken (2026-03) | taken (23 dl) | registered — **live EMS/healthcare software co** ([syncytium.com](https://syncytium.com/)) | **0** | Biologically the most accurate metaphor: many nuclei, one continuous shared interior. But `.com` is an active software business and all three registries went in March 2026. |
| **Chiasm** | taken | **free** | **free** | registered | **1** (CHIASMA, Amryt Endo — pharma) | Short, means "crossing point". npm gone; pharma mark is adjacent-but-different. |
| **Fornix** | **free** | **free** | taken | registered | **2**, incl. **FORNIX AI, Inc.** | Semantically ideal — the tract carrying signal out of the hippocampus, and *fornix* = vault. But an AI company already holds the mark in our classes. Eliminated on that alone. |

Notable: `commissure.com` expires **2026-11-06**, `syncytium.com` **2026-09-10**, `astrocyte.com` **2026-10-26** — all within months. Worth watching for a drop, not worth planning around.

### Ranked shortlist of three

**1. Commissure** — *collision risk: LOW.* The only entity ever to use the name in software was Commissure Inc., a medical-imaging company **acquired by Nuance in 2007** and dormant since; there is **no live company, no product, and zero filed or registered trademark in Nice classes 9 or 42 across both the USPTO and EUIPO**. It is the only candidate in this entire study — fifteen names — where **npm, PyPI and crates.io are all simultaneously free**. Residual risks are real but ordinary: `.com` and `.ai` are both registered to third parties, so the launch domain must be a variant or an acquisition; and the anatomical register invites medical mis-association, though far less than Thalamus or Ganglion. It also earns the metaphor — a commissure is precisely the fibre bundle that lets separated hemispheres share the same facts.

**2. Ganglion** — *collision risk: LOW-MEDIUM.* Cleanest of the ten given candidates by trademark load: exactly **one** hit in classes 9/42, and it is "Ganglionorm", not a conflict. The real drags are that all three package registries are taken (npm dead since 2015, but PyPI and crates active), `.com` has been held since 2000, and ganglion.ai is a medical-device company doing pupillary screening. Semantically it is also weaker for us: a ganglion is a *local* cluster, which undersells an org-wide shared substrate.

**3. Claustrum** — *collision risk: MEDIUM-HIGH, and the highest of the three.* Stated plainly: **Life2, Inc. holds a live "CLAUSTRUM AI" mark in Nice classes 9/42**, which is our name plus our sector in our classes. That is a direct and foreseeable obstacle, mitigated only by their being in healthcare rather than developer infrastructure. It ranks third because crates.io is free and the neuroscience is flattering — the claustrum is theorised as a cortical integration hub — but this is the one option that would need a trademark attorney's opinion *before* any spend, not after.

Below the line and not recommended: Continuum (106 marks), Praxis (127 marks, plus Google's library), Substrate (24 marks incl. Epic Games, three live AI/semiconductor companies), Engram ($98M direct competitor in AI memory), Callosum ($100M adjacent AI-infra startup plus Rolls Royce's mark).
