# Durable execution & distributed-state substrates — adversarial review

Scope: production orchestration / durable-execution / distributed-state systems that could plausibly carry shared agent state. Excludes agent protocols (MCP/A2A/AGNTCY/ANP) and vendor agent-product blogs — other agents own those.

Date of evidence: 2026-08-24. Every numeric claim carries a URL.

---

## What exists

### 1. Temporal

**Architecture.** Workflow-as-code determinism. The server stores an append-only **Event History** per Workflow Execution; workers rebuild state by deterministic replay of that history. Search Attributes are a separate *Visibility* index (Elasticsearch or SQL), not the primary store.

**Hard limits** (all from <https://docs.temporal.io/cloud/limits>, corroborated for OSS at <https://docs.temporal.io/self-hosted-guide/defaults>):

| Limit | Value |
|---|---|
| Event History | **51,200 events or 50 MB** → Workflow terminated. Warns at 10,240 events / 10 MB. Non-configurable on Cloud. |
| Per-message gRPC | **4 MB** (all endpoints) |
| Payload blob (single request) | **2 MB** error, **256 KB** warn |
| Event-History transaction | **4 MB** |
| Pending activities / signals / child WFs / cancel requests | **2,000** each (recommend ≤500) |
| Signals per execution (lifetime) | **10,000**, then no more are processed |
| Updates | **10 in-flight, 2,000 total in history** |
| Callbacks per execution | **2,000** |
| Nexus operations in-flight | **30** per execution |
| Identifier length | 1,000 bytes |
| Retention | 1–90 days, default **30 days** |
| Visibility API (List/Count/Scan) | **30 calls/sec, not configurable** |
| Concurrent task pollers | 20,000 activity + 20,000 workflow per namespace |
| Batch jobs | 1 concurrent job/namespace, 50 executions/sec |
| Default throughput | 500 actions/sec (On-Demand floor) |
| Timers | max 100 years |

**Search Attributes — not a store.** Cloud caps per namespace: Keyword 40, Bool/Datetime/Double/Int 20 each, KeywordList 5, Text 5 (<https://docs.temporal.io/cloud/limits>). Self-hosted SQL visibility is far tighter: 10 Keyword, 3 of everything else (<https://docs.temporal.io/search-attribute>). Value size **2 KB**, **total 40 KB** per execution, **255 characters** per value. They are **stored unencrypted** and not run through the Payload Codec — the docs explicitly say do not put PII or secrets in either names or values. And critically: *"Search Attribute values are only available for as long as the Workflow is"* — they die with retention. The docs themselves route you elsewhere: "consider… storing state in an external datastore through Activities" (<https://docs.temporal.io/search-attribute>).

**Continue-as-new.** Checkpoints selected state into a new execution with the **same Workflow Id, new Run Id, fresh Event History** (<https://docs.temporal.io/workflow-execution/continue-as-new>). It is the sanctioned escape from both history bloat *and* versioning drift: "To prevent long-running Workflows from running on stale versions of code, you may also want to Continue-as-New periodically." Each CAN is a billable Action (<https://temporal.io/pricing>).

**Nexus.** Cross-namespace/cross-service calls via a named Endpoint that reverse-proxies to a target namespace + task queue. Peer-to-peer, not hierarchical. **GA on 2025-03-05** (<https://temporal.io/changelog/temporal-nexus-now-available>). At-least-once, exponential backoff, circuit breaker trips after **5 consecutive retryable errors**; sync handler deadline **<10 seconds**; async op max ScheduleToClose **60 days** (<https://docs.temporal.io/nexus>, <https://docs.temporal.io/cloud/limits>). Account default 100 endpoints, 1,000 caller namespaces per endpoint. Nexus calls are billed as Actions.

**Pricing** (<https://temporal.io/pricing>): Essentials from **$100/mo** (1M Actions, 1 GB Active Storage = 744 GBh, 40 GB Retained). Business **$500/mo** (2.5M Actions). Overage: $50/M Actions for the first 5M, sliding to $25/M above 100M. Storage: **Active $0.042/GBh**, **Retained $0.00105/GBh** — Active storage is **40× the price of Retained**, i.e. long-lived open workflows are the expensive thing. Plan fee = max(minimum, 5%/10% of consumption). HA replication applies a flat **2× multiplier** to Actions *and* Storage. Task Queue Fairness adds **+0.1 Actions per Action** namespace-wide whether or not you use fairness keys.

---

### 2. Inngest

**Architecture.** Event-driven durable steps over your own HTTP endpoints (or Connect). `step.run(id, fn)` memoizes by step id; on retry the engine replays memoized results and only re-executes from the last uncompleted step (<https://www.inngest.com/docs/learn/inngest-functions>).

**Hard limits** (<https://www.inngest.com/docs/usage-limits/inngest>):

| Limit | Free | Basic | Pro | Enterprise |
|---|---|---|---|---|
| Max concurrent steps | 5 | 25 | 200+ | custom |
| Single event size | 256 KiB | 512 KiB | 3 MiB | custom |
| Trace/log history | 24h | 7d | **14d** | 90d |
| **Event lookback period** | **1 hour** | **1 hour** | **3 days** | custom |
| Max function run length | 30d | 90d | 366d | custom |

Platform-wide, non-plan: step sleep up to 1 year (7d on Free); **step timeout max 2 hours**; step-returned payload **4 MiB**; **function run state cap 32 MiB** (event data + all step data + return value + metadata); **1,000 steps per function**; 5,000 events per send request; batch hard cap 10 MiB.

**What state it retains, and for how long.** Very little, and not for long. Run state is transient working state bounded at 32 MiB. Observability data (traces/logs) is retained 24h → 90d by plan. The **event lookback period** — 1 hour on Free/Basic, 3 days on Pro — is the window in which events remain matchable/queryable; it is the closest thing Inngest has to an event store, and it is measured in *hours* on the entry plans. Function Replay is a dashboard bulk-rerun over a time range + run statuses (<https://www.inngest.com/docs/platform/replay>), i.e. re-execution, not a queryable history.

**Flow control.** Five primitives: concurrency, throttling, rate limiting, debounce, priority (<https://www.inngest.com/docs/guides/flow-control>). This is the most complete flow-control surface of anything in this review.

**`step.waitForEvent`** takes `event`, `timeout` (ms string / number / absolute Date / Temporal), and either `match` (dot-notation property equality) or `if` (a CEL expression over `event` and `async`). CEL's `in` operator is **not supported** — you must expand to `==` chains (tracked as issue #3907). Sharp edge worth knowing: inside a `group.parallel()` race, **a losing `waitForEvent` is not cancelled** — it stays an active pause and holds the run in Running state until its timeout fires (<https://www.inngest.com/docs/reference/typescript/v4/functions/step-wait-for-event>).

**Pricing** (<https://www.inngest.com/pricing>): Hobby $0 (50k executions, 500k events, 5 concurrent steps, 100k queue depth). Pro **$99/mo** (1M executions included, PAYG to 20M; 100 concurrent steps then **$25 per 25**; 5M events then **$0.50/M**; 1M queue depth; 5 GB span data then $3/GB). "An execution is a single durable function run plus each step inside it" — a 5-step function costs 6 executions.

**Documentation contradiction (adversarial note).** The pricing page's comparison table lists Pro trace/log history as **7 days**, and the Pro plan card says "7 day trace retention"; the docs limits table says **14 days** for Pro (<https://www.inngest.com/pricing> vs <https://www.inngest.com/docs/usage-limits/inngest>). One of these is wrong. Do not plan retention against either without confirming in-product.

---

### 3. Restate

This is the only system in this review that ships durable execution **and** a first-class per-key state store in the same commit path.

**Three service types** (<https://docs.restate.dev/foundations/services>):

| | Basic Service | Virtual Object | Workflow |
|---|---|---|---|
| State | none | **isolated per object key** | isolated per workflow instance |
| Concurrency | unlimited | **single writer per key + concurrent shared (read-only) handlers** | single `run` per ID + concurrent shared handlers |

**Virtual-object state model** (<https://docs.restate.dev/develop/ts/state>):
- API is exactly: `ctx.stateKeys()`, `ctx.get<T>(key)` (returns null if absent), `ctx.set(key, val)`, `ctx.clear(key)`, `ctx.clearAll()`. Values are JSON-serialised by default.
- **State exists only on Virtual Objects and Workflows.** Basic services have none.
- **Scope & retention**: VO state is scoped per object key and **retained indefinitely** until explicitly cleared. Workflow state is scoped per workflow execution and lives only for the workflow retention period (default **24 hours**, <https://docs.restate.dev/services/configuration>).
- **Exclusive handlers read+write; shared handlers read-only, cannot mutate.**
- **Eager (default) vs lazy loading**: eager ships a full snapshot of the object's K/V entries with every invocation request; lazy fetches per `ctx.get` from the server, which on Lambda/FaaS (no bidi streaming) forces a suspend+replay per read (<https://docs.restate.dev/services/configuration>).

**Journal & commit semantics** (<https://docs.restate.dev/references/architecture>): the replicated log ("Bifrost") is ground truth. A step "happens" when the partition leader appends its record and gets **quorum acks**. Each partition has one processor leader that tails the log and maintains a **RocksDB materialised cache** of journals, idempotency metadata, key-scoped state and timer indices — explicitly "derivative… not a second source of truth". Control plane is built-in **Raft**; recovery is bounded by periodic RocksDB snapshots uploaded to **S3**, then log trimming. Retries carry monotonically increasing **epochs** and superseded-epoch events are fenced, which is how zombie writers are excluded. Cross-partition messages are delivered exactly once via an internal shuffler with sequence-number dedup. **Partition count is fixed at cluster creation today.**

**Coordination primitives** (<https://docs.restate.dev/develop/ts/external-events>):

| Primitive | Addressed by | Resolution |
|---|---|---|
| Signal | invocation ID + name | **resolvable many times**; each await gets the next resolution; resolutions stored durably even if they arrive before the wait |
| Awakeable | generated unique ID | resolve/reject **once**; completable by external systems over HTTP (`POST /restate/awakeables/<id>/resolve`) |
| Workflow promise | workflow key + name | resolve/reject once; result readable **many times by all handlers** for the workflow retention period |

**Defaults** (<https://docs.restate.dev/services/configuration>): retry policy initial 50ms, factor 2.0, **max-attempts 70**, max-interval 60s, on-max-attempts **pause** (not kill). Idempotency retention 24h; workflow retention 24h; journal retention 24h. Inactivity timeout 1 min; abort timeout 10 min.

**Restate's own stated limitations of its K/V** (<https://docs.restate.dev/guides/databases>) — this is the most useful page in the whole review:
- "K/V interface with **single-key transactions**" only.
- "**SQL is supported only for analytics / introspection, not for updates/transactions.**"
- "**Modifiable only from the Virtual Object**, not from other services. Any modification needs to be sent as a request to the Virtual Object."
- Restate tells you to use a database for "complex access patterns, full SQL, text search, time-series analysis" and for "core business data… that you want to access from other services as well."

**Flow control** (<https://docs.restate.dev/services/flow-control>): opt-in, behind `experimental-enable-protocol-v7` / `experimental-enable-vqueues`, "configuration and APIs may change." Scope values ≤36 chars, `[a-zA-Z0-9_.-]`. Limit keys nest two levels (`l1/l2`); an invocation draws from scope + L1 + L2 budgets simultaneously and the strictest wins. Rule specificity: exact beats wildcard, ranked scope → L1 → L2, so `checkout/premium` > `checkout/*` > `*/premium`. **A `*` limit is per-scope, not a global pool.** Notably, scope becomes part of *identity*: idempotency keys and virtual-object keys are namespaced by scope.

**Unverified:** Restate publishes **no numeric limit** for state size per key or per virtual object anywhere I could find in the docs or the Create/Modify state admin API. `docs.restate.dev/server/memory` covers server memory config, not per-object state caps. Design against the eager-state-per-request cost, not against a documented ceiling.

---

### 4. LangGraph / LangGraph Platform

**Two distinct systems** (<https://docs.langchain.com/oss/python/langgraph/persistence>):

| | Checkpointer | Store |
|---|---|---|
| Persists | graph state snapshots | app-defined key-value data |
| Scope | **a single thread** | across threads |
| Access | `thread_id` in config | `put/get/search` from nodes |

**Checkpointer** (<https://docs.langchain.com/oss/python/langgraph/checkpointers>): one checkpoint per **super-step** boundary; plus per-task writes to a `checkpoint_writes` table so a partial super-step failure doesn't re-run the succeeded nodes ("pending writes"). `checkpoint_ns` is `""` for the root graph and `"node_name:uuid"` for subgraphs, joined with `|` when nested. `StateSnapshot` carries `values`, `next`, `config{thread_id, checkpoint_ns, checkpoint_id}`, `metadata{source, writes, step}`, `created_at`, `parent_config`, `tasks`. `get_state_history()` returns the chain newest-first. `update_state()` **creates a new checkpoint rather than mutating the original**, and passes values through channel reducers. Durability modes: `exit` / `async` / `sync`.

**Is the checkpointer a bitemporal store? No.** It is a singly-linked chain of per-thread whole-state snapshots, keyed by `(thread_id, checkpoint_ns, checkpoint_id)` with **one time axis** (`created_at`, i.e. assert time). There is no valid-time, no supersession relation beyond `parent_config`, no per-fact identity, no cross-thread query. Replay re-executes nodes after the chosen checkpoint including LLM calls and interrupts — it is a re-execution mechanism, not an as-of read.

Its own docs list unbounded growth as a known problem, and the prescribed fix is manual: "Prune old checkpoints periodically… Consider adding a cron job to delete checkpoints older than N days" (<https://docs.langchain.com/oss/python/langgraph/persistence>). `DeltaChannel` mitigates append-heavy channels but requires `langgraph>=1.2` and is **beta, API may change** (<https://docs.langchain.com/oss/python/langgraph/checkpointers>). Also documented: `PostgresSaver` `thread_id` must stay under 255 chars; subgraph state changes are not immediately visible to the parent because each subgraph has its own checkpoint namespace.

**Store** (<https://docs.langchain.com/oss/python/langgraph/stores>): namespaces are arbitrary-length string tuples; item fields are exactly `value`, `key`, `namespace`, `created_at`, `updated_at`. **There is no provenance, no confidence, no validity interval, no version chain, and no supersession concept.** `put` overwrites. Optional embedding index via `index={"embed": …, "dims": …, "fields": [...]}`, with per-write `index=[...]` or `index=False`. Three documented sharp edges: `namespace_prefix` matches by **prefix, not exactly** (`("alice",)` also returns `("alice","preferences")`); **results past `limit` are silently truncated with no overflow signal**; default ordering is backend-dependent (Postgres = `updated_at` desc, InMemory = insertion order).

**Multi-writer conflict handling: none documented.** No CAS, no ETag, no optimistic-concurrency token on `BaseStore.put`. Last write wins.

**Package recency** (PyPI JSON API, fetched 2026-08-24):
- `langgraph` 1.2.11 (2026-08-11), `langgraph-checkpoint` 4.2.0 (2026-08-07), `langgraph-checkpoint-postgres` 3.1.2 (2026-08-07), `langgraph-checkpoint-redis` 0.5.2 (2026-08-20) — all actively maintained.
- **`langmem` is effectively stalled**: latest release **0.0.30, uploaded 2025-10-27** — ~10 months stale, still 0.0.x, still pinned to `langgraph<2,>=0.6.0` (<https://pypi.org/pypi/langmem/json>). Do not build on it.

**Platform pricing** (<https://www.langchain.com/pricing>): Developer $0/seat (5k base traces/mo); Plus **$39/seat/mo** (10k base traces); metered in **LCU at $1.50** and **LSU at $1.00**. Deployments: 1 free Serverless (Small) on Plus; beyond that, Runtime Compute **0.045 LCU/vCPU-hr**, Runtime Memory **0.006 LCU/GiB-hr**, Database Compute **0.177 LSU/vCPU-hr**, Database Memory **0.025 LSU/GiB-hr**. Note the DB compute rate is ~4× runtime compute in LCU-equivalents — the managed Postgres behind the checkpointer is the cost centre.

---

### 5. Ray

**GCS.** The Global Control Store "manages cluster-level metadata… actor, placement groups and node management. **By default, the GCS isn't fault tolerant because it stores all data in memory. If it fails, the entire Ray cluster fails**" (<https://docs.ray.io/en/latest/ray-core/fault_tolerance/gcs.html>). Two FT backends: external **HA Redis** — "officially supported *only* if you are using KubeRay for Ray Serve fault tolerance. For other cases, you can use it at your own risk" — or **embedded RocksDB, alpha, Linux only**, single-writer on the storage path.

During GCS recovery the following are unavailable: actor creation/deletion/reconstruction, placement-group ops, resource management, worker node registration, worker process creation. Running tasks/actors survive. **A raylet that cannot reconnect to the GCS for 60 seconds exits and its node fails** (`RAY_gcs_rpc_server_reconnect_timeout_s`).

**Named/detached actors as a registry** (<https://docs.ray.io/en/latest/ray-core/actors/named-actors.html>): `Actor.options(name=…, lifetime="detached")`, retrieved by `ray.get_actor(name, namespace=…)`, with `get_if_exists=True` for get-or-create. Names are namespace-scoped; anonymous namespace by default. Detached actors are **not garbage collected** and must be manually `ray.kill`ed; the name is only reusable after that.

**Actor fault tolerance** (<https://docs.ray.io/en/latest/ray-core/fault_tolerance/actors.html>): `max_restarts` defaults to **0** — actors are not restarted. On restart, "**its state will be recreated by rerunning its constructor**" — the framework restores nothing. `max_task_retries` defaults to 0 = **at-most-once**. The docs are explicit: "For actors that have critical state, the application is responsible for recovering the state, e.g., by taking periodic checkpoints." Non-detached actors **fate-share with their owner**: "Ray will not automatically recover an actor whose owner is dead, even if it has a nonzero `max_restarts`." `ActorUnavailableError` gives no guarantee about whether the task executed.

**Object store / Plasma** (<https://docs.ray.io/en/latest/ray-core/fault_tolerance/objects.html>): data lives in the object store, metadata at the **owner** (the worker that created the ObjectRef). Recovery is by **lineage reconstruction** — re-executing the task that produced the value. Documented limits: "**objects created by `ray.put` are not recoverable**"; "**by default, objects created by actor tasks are not reconstructable**"; non-actor tasks retry 3× by default, actor tasks 0×; "**Ray does not support recovery from owner failure**" → `OwnerDiedError` and the copies are garbage-collected. Lineage metadata is capped by `RAY_max_lineage_bytes` (**default 1 GB**) and evicted past it. Spilling goes to a local filesystem directory, `/tmp/ray/session_*` by default (<https://docs.ray.io/en/latest/ray-core/objects/object-spilling.html>).

**Blunt: is Ray a plausible substrate for a persistent shared fact store? No.** Not "no with caveats" — no. Its metadata plane is an in-memory SPOF whose *official* HA path is scoped to one product (Ray Serve on KubeRay) and whose alternative is alpha. Its actor state is reconstructed by rerunning `__init__`. Its object store loses `ray.put` values permanently and fate-shares objects with a *worker process*. Ray is a compute scheduler with an object cache. Every durability property we need would have to be built above it in an external database, at which point Ray contributes nothing to the store.

---

### 6. Dapr

**Actors** (<https://docs.dapr.io/developing-applications/building-blocks/actors/actors-features-concepts/>): virtual actors, activated on first message, GC'd after idle. **Turn-based concurrency**: a per-actor lock is acquired at the start of a turn and released at the end; "no more than one thread can be active inside an actor object's code at any time," enforced across methods, timers and reminders. Placement service partitions actor types across sidecars by hashing type+id. Two consequences the docs state plainly: "actors are randomly placed into pods… **it should be expected that actor operations always require network communication**, including serialization and deserialization"; and "**Actors can deadlock on each other** if there is a circular request between two actors while an external request is made to one of the actors simultaneously" — resolved only by a call timeout.

**State store API** (<https://docs.dapr.io/developing-applications/building-blocks/state-management/state-management-overview/>):
- **Default is eventual consistency + last-write-wins.** "By default, your application should assume a data store is eventually consistent and uses a last-write-wins concurrency pattern."
- **ETag OCC is opt-in**: get returns an ETag; update attaches it in the body, delete in `If-Match`. Omitting the ETag silently degrades to last-write-wins. For stores without native ETags, "the corresponding Dapr state store implementation is expected to **simulate** ETags."
- Strong consistency waits for all replicas/quorum; eventual returns on first accept.
- Bulk (non-atomic, N individual requests) vs **transactional** (atomic multi-item) — and transactional support is store-dependent.
- **Actor state requires a transactional store** with `actorStateStore: true`, and "**Only a single state store component can be used as the state store for all actors**"; if distributed, "you must make sure that it provides strong consistency."
- Direct queries against the underlying store "are **not governed by Dapr concurrency control**."
- Per-item TTL (`ttlInSeconds`); the docs say you should *always* set it on actor state.

**Workflows are built on Temporal's durabletask-go — confirmed.** `dapr/dapr` `go.mod` line 15: `github.com/dapr/durabletask-go v0.13.0` (<https://raw.githubusercontent.com/dapr/dapr/master/go.mod>). It is Dapr's fork of the Durable Task engine. Documented workflow limits (<https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/>): only workflow-capable state stores may be used; **Azure Cosmos DB has payload and workflow-complexity limitations**; **AWS DynamoDB has workflow-complexity limitations**. Newer additions: optional cryptographic **history signing** (mTLS + `WorkflowHistorySigning` flag; tamper → `DAPR_WORKFLOW_HISTORY_TAMPERED`, and once enabled it cannot be disabled) and **history propagation** to child workflows/activities.

**Actor reminders at scale — real issues:**
- **[#5671 "Actor reminders does not scale horizontally"](https://github.com/dapr/dapr/issues/5671)** — opened 2022-12-22, **still open** as of 2026-08-24. "When running a large number of actors (in my test case about **0.5 million**) with reminders for each actor, and CosmosDB as the state store, you run into time-outs and finally exceptions **due to all the reminders for an actor type being stored in a single document**."
- Dapr's own docs confirm the failure class: "Applications with multiple reminders registered can experience… low throughput on reminders registration and de-registration… limited number of reminders registered based on the single record size limit on the state store" (<https://docs.dapr.io/developing-applications/building-blocks/actors/howto-actors-partitioning/>).
- Mitigation history: reminder **partitioning** shipped in v1.3.0 (2021) as a config knob; the architectural fix — [#5403 "Move actor timer and reminder functionality into Dapr's control plane"](https://github.com/dapr/dapr/issues/5403) — was only closed 2024-08-19, and Scheduler-based reminders became the default in **v1.15**. [#6121 "Incremental improvements to Actor Reminders subsystem"](https://github.com/dapr/dapr/issues/6121) is still open. That is a **~3.5-year window** in which the flagship stateful-actor timer primitive did not scale.

---

### 7. Cloudflare Durable Objects + Agents SDK (+ D1 for contrast)

**Model.** One single-threaded actor instance per object ID, co-located with its own embedded SQLite database, addressed globally by ID.

**Limits, SQLite backend** (<https://developers.cloudflare.com/durable-objects/platform/limits/>):

| | |
|---|---|
| Objects per account/class | unlimited |
| DO classes per account | 500 (Paid) / 100 (Free) |
| **Storage per Durable Object** | **10 GB** (Paid); 1 GB on Free; 5 GB total account on Free |
| Key + value combined | **2 MB** |
| WebSocket message (inbound) | 32 MiB |
| CPU per request | 30 s default, configurable to **5 min** via `limits.cpu_ms`; each inbound request or WS message **resets** the 30 s budget |
| Simultaneous outgoing connections | 6 |
| SQL | 100 columns/table, **2 MB** max string/BLOB/row, 100 KB max statement, 100 bound params, 50-byte LIKE/GLOB pattern |
| Throughput | **soft limit ~1,000 req/s per object**; over that → `overloaded` error |
| Wall time | unlimited for HTTP/RPC while the caller is connected; **alarm handlers 15 min** |

Exceeding 10 GB gives `database or disk is full: SQLITE_FULL`; reads and DELETEs still work.

**Alarms as heartbeat/timer** (<https://developers.cloudflare.com/durable-objects/api/alarms/>): **one alarm at a time per object**; `setAlarm(ms)` overwrites; at-least-once execution; retry is exponential backoff **starting at 2 s with at most 6 retries** — the docs themselves warn "a sufficiently long outage in a downstream service… can exhaust the limited number of retries, causing the alarm to not be re-run in the future." `alarmInfo.retryCount` / `.isRetry` are exposed. Multiple schedules must be hand-rolled by storing an event table and rescheduling from the handler.

**Point-in-time recovery.** SQLite-backed DOs expose a PITR API using lexically-comparable **bookmarks** (e.g. `0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b`) that restore the object's whole database **to any point in the past 30 days**, covering both SQL tables and KV-API data (<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>). The mechanism: the storage layer keeps a complete change log and, rather than deleting log segments after snapshotting, "merely marks them for deletion **30 days later**" (<https://blog.cloudflare.com/sqlite-in-durable-objects/>).

**Placement.** Objects are created near the first `get()` and "**do not currently change locations after they are created**". Jurisdictions `eu` / `us` / `fedramp` pin residency; location hints (`wnam`, `enam`, `weur`, `apac`, …) are best-effort only (<https://developers.cloudflare.com/durable-objects/reference/data-location/>).

**Pricing** (<https://developers.cloudflare.com/durable-objects/platform/pricing/>):
- Requests: 1M/mo included, then **$0.15/M**. WebSocket inbound messages are billed at a **20:1 ratio**.
- Duration: 400,000 GB-s/mo included, then **$12.50/M GB-s**, billed against **128 MB regardless of actual memory**, wall-clock while non-hibernatable.
- SQL: rows read 25B/mo then **$0.001/M**; rows written 50M/mo then **$1.00/M** (deletes and each `setAlarm()` count as a row written); stored data 5 GB-month then **$0.20/GB-month**. **SQLite storage billing only started ~2026-01-07.**
- Their own worked example: 100 DOs × 1 always-on WebSocket for a month = **$419.30/mo**; the same workload with WebSocket Hibernation = **$20.65/mo**. Hibernation is a 20× cost lever, not an optimisation.

**Agents SDK (`agents` npm)** (<https://developers.cloudflare.com/agents/runtime/lifecycle/state/>): state is **JSON stored in the per-agent embedded SQLite DB**. `initialState` applied lazily on first access; `this.state` getter; `this.setState(obj)` (1) writes to SQLite, (2) broadcasts to all connected WebSocket clients, (3) fires `onStateChanged(state, source)`. Advertised as persistent, synchronized, bidirectional, immediately consistent (read-your-writes), thread-safe. `this.sql` gives direct SQL escape. The pushed model is **whole-object JSON replace** — `setState({...this.state, score: n})` — with client-authored writes allowed. There is no versioning, no CAS, no provenance, no partial update primitive at the `setState` layer.

**D1 for contrast** (<https://developers.cloudflare.com/d1/platform/limits/>): 10 GB max per database (**"cannot be further increased"**), 50,000 DBs/account (Paid), 1 TB account storage, **Time Travel PITR 30 days** (7 on Free), 10 restores per 10 min, 1,000 queries per Worker invocation, 30 s max query, 2 MB row. "Each individual D1 database is inherently single-threaded"; "each individual D1 database is backed by a single Durable Object." D1 is a DO with SQL ergonomics and a management API — same 10 GB ceiling, same single-threaded write path.

---

### 8. Redis Streams and NATS JetStream

#### Redis Streams

Append-only log implemented as a **radix tree** of macro-nodes (<https://redis.io/docs/latest/develop/data-types/streams/>).

- **Consumer groups**: `XREADGROUP` with `>` for new messages, or an explicit ID to re-read the consumer's PEL. `XACK` removes from PEL. `XPENDING` inspects. `XCLAIM` / `XAUTOCLAIM` (with a cursor) reassign idle messages.
- **Delivery semantics are at-least-once, full stop.** The docs: "claiming a message will reset its idle time and will increment its number of deliveries counter… **in the general case you cannot obtain exactly once processing**."
- **Trimming**: `XADD … MAXLEN n` / `XTRIM MAXLEN n` evicts oldest. `MAXLEN ~ n` is the approximate form — trimming happens only when a whole macro-node can be dropped, so you may hold 1000 or 1010 or 1030. **There is no time-based retention option**: "There is currently no option to tell the stream to just retain items that are not older than a given period." Redis 8.2 adds `KEEPREF` (default) / `ACKED` trim modes for consumer-group PEL awareness.
- **Durability is weak by default**: "By default the asynchronous replication will **not guarantee that `XADD` commands or consumer groups state changes are replicated**: after a failover something can be missing." `WAIT` reduces but does not eliminate this, because "the Redis failover process as operated by Sentinel or Redis Cluster performs only a **best effort** check to failover to the replica which is the most updated, and under certain specific failure conditions may promote a replica that lacks some data." AOF must be configured with a strong fsync policy.
- `XDEL` removes entries by ID from the middle (for privacy/GDPR). Streams are allowed to remain at zero length so consumer-group state survives.

**Why Redis Streams is not a fact store:** entries have no identity beyond a monotonic `ms-seq` ID, no per-entry query beyond ID/time range, no secondary index, no schema, no compare-and-set on an entry, mandatory bounded retention with no time-based policy, and a replication model that admits data loss on failover. It is a log with cursors.

#### NATS JetStream — streams

Config surface (<https://docs.nats.io/reference/jetstream/api/stream/create>):

| Field | Semantics / bounds |
|---|---|
| `retention` | `limits` (evict on limit) / `interest` (drop once all matching consumers ack) / `workqueue` (drop on first ack; consumers must use non-overlapping filters) |
| `max_msgs` | int64, `-1` unlimited |
| `max_bytes` | int64, `-1` unlimited |
| `max_age` | **nanoseconds**, int64, `0` unlimited |
| `max_msgs_per_subject` | per-subject retention limit, `-1` unlimited |
| `max_msg_size` | **int32**, max 2,147,483,647, `-1` unlimited |
| `num_replicas` | **minimum 1, maximum 5**, default 1 → this is R1/R3/R5 (even values are legal but pointless for quorum) |
| `discard` | `old` (drop oldest) / `new` (reject the publish) |
| `duplicate_window` | ns; dedup window |
| `storage` | `file` / `memory` (memory does not survive restart) |
| `deny_delete`, `deny_purge`, `sealed` | one-way locks; `sealed` cannot be un-sealed via config update |
| `allow_direct` | enables consumer-free direct reads |
| `allow_rollup_hdrs` | enables `Nats-Rollup` to collapse a subject to one message |

All limits are active simultaneously; **the first one hit triggers the discard**. `MaxAge` expires messages on its own timer under either discard policy — it is not a discard-policy choice (<https://docs.nats.io/learn/jetstream/shaping-the-stream>).

#### NATS JetStream KV — the precise semantics

This is the closest existing thing to a versioned fact store, so, exactly:

**Physical model** (<https://docs.nats.io/learn/key-value/>, <https://docs.nats.io/learn/key-value/under-the-hood>). A bucket **is** a JetStream stream named `KV_<bucket>` whose subjects are `$KV.<bucket>.>`. **A key is the last token of the subject; a value is a message on that subject.** For bucket `INVENTORY`, key `widget-blue` is the message on `$KV.INVENTORY.widget-blue`.

The stream config the server generates for a KV bucket:
- `Subjects: $KV.<bucket>.>`
- `Discard Policy: New` — at a limit the bucket **rejects the newest write** rather than silently evicting
- `Direct Get: true`
- `Allows Rollups: true`
- `Allows Msg Delete: false` (`deny_delete`) — raw stream deletes cannot bypass the KV API
- `Maximum Per Subject: <history depth>`

**Revisions** (<https://docs.nats.io/learn/key-value/history-and-revisions>):
- A revision is the **stream sequence number** of the message: "its sequence is the revision, and its store time is the entry timestamp" (under-the-hood).
- The counter is **bucket-wide, not per key**: "The bucket keeps one counter across all of its keys, and every write — to any key — takes the next number. So a revision always increases when you write a key, but not by one each time: writes to other keys advance the counter in between."
- The revision is assigned by the server, never by the client, and is returned on `get` as part of the entry.
- **Design implication for us:** a bucket revision is a *total order over all writes in the bucket*, i.e. a free monotonic assert-time sequence with cross-key comparability.

**History** (same page):
- History depth is set per bucket (`--history`, `nats kv edit BUCKET --history 10`) and maps directly to the stream's `max_msgs_per_subject`.
- **The depth caps at 64.** "The depth caps at 64… it doubles as a per-key cap: it's the most messages any single key may hold" (<https://docs.nats.io/learn/key-value/ttl-and-limits>).
- Raising the depth is **not retroactive**: revisions already dropped at the lower depth are gone.
- Once a key exceeds the depth the oldest revision is removed. "History holds the prior revisions of a single key, up to the depth. **It isn't an audit log of the whole bucket**."
- `kv history KEY` returns entries oldest-first with `Key, Revision, Op, Created, Length, Value`. Ops are `PUT`, `DELETE`, `PURGE`.

**Compare-and-swap** (same page):
- `create(key, value)` — succeeds only if the key is at revision 0 (does not exist).
- `update(key, value, expectedRevision)` — succeeds only if the key is still at that revision.
- Failure mode is explicit and unforgiving: "**A rejected update is dropped rather than queued, and you must retry.** … If you fire-and-forget an update, a conflict silently loses the write." The caller must own the re-get-and-retry loop.
- Correctness note the docs call out: read value and revision from a **single** `get`; two separate gets can pair a stale value with a fresh revision.

**Reads** (under-the-hood): `get` uses **Direct Get** — a request to `$JS.API.DIRECT.GET.<stream>.<subject>` returning the last message on that subject straight from storage. No consumer, no position, no ack, no cleanup. One request, one reply.

**Delete vs purge** (under-the-hood) — these differ and it matters:
- **Delete** writes a marker message with header `KV-Operation: DEL`. The key reads empty; **all prior revisions remain in the stream, up to the history depth, and remain readable via history.** Non-destructive.
- **Purge** writes a marker with `KV-Operation: PURGE` **and** `Nats-Rollup: sub`. The rollup instructs the stream to drop every earlier message on that subject. **History collapses to a single entry; the prior values are gone from disk.** Destructive — this is the GDPR/erasure primitive.

**TTL and bucket limits** (<https://docs.nats.io/learn/key-value/ttl-and-limits>):
- Per-key TTL is set at **`create` time only**. Neither `put` nor `update` accepts a TTL; writing the key again with `put`/`update` **appends a value with no TTL, so the key silently stops expiring**. To change a TTL you must delete and re-create.
- Per-key TTL requires bucket **limit markers** (`nats kv edit BUCKET --marker-ttl 1h`, i.e. `LimitMarkerTTL`) and **nats-server 2.11 or newer**.
- Expiry leaves a marker with reason `MaxAge`; **watchers observe it as a `PURGE` operation**, so live readers stay correct.
- Bucket-level limits: max bucket size (total bytes across all keys and kept revisions), max value size (single value; "large values belong in the Object Store"), and history depth. Bucket `--ttl` is the stream `MaxAge` and expires *every* value at that age — a different clock from the per-key TTL.
- Because a KV bucket is **discard-new**, a put that would exceed max-bucket-size or max-value-size is **rejected with an error**; existing values are kept.

**Object Store**: the documented home for large values that don't belong in KV (<https://docs.nats.io/learn/object-store/>).

---

## What is proven vs claimed

**Proven — documented, numeric, and in wide production use:**
- Temporal's replay determinism and its limits. The 51,200-event / 50 MB ceiling and the 2 MB payload / 4 MB transaction limits are stated identically on both the Cloud limits page and the self-hosted defaults page, with links to the source constants in `temporalio/temporal`. These are real, enforced, and non-configurable on Cloud.
- Restate's commit model. The architecture page describes a concrete mechanism (quorum append to a segmented replicated log, epoch fencing, derivative RocksDB materialisation, S3 snapshot + log trim) at a level of detail you cannot bluff, and the OSS server is on GitHub.
- NATS KV revision/history/CAS semantics. Verifiable against the stream config the server itself reports (`Maximum Per Subject`, `Direct Get`, `Allows Rollups`, `Allows Msg Delete`); the abstraction is thin enough to audit.
- Cloudflare DO per-object limits and pricing. Cloudflare publishes worked cost examples with arithmetic, including the unflattering ones ($419/mo for 100 always-on WebSocket objects).
- Dapr's actor turn-based concurrency and ETag OCC. Also *proven* is the reminder scale failure — #5671 with a concrete 0.5M-actor repro, and Dapr's own docs conceding the single-document bottleneck.
- Ray's fault-tolerance gaps. Unusually honest docs: they state outright that GCS is a SPOF by default, that `ray.put` objects are unrecoverable, and that owner failure is unrecoverable.

**Claimed but not substantiated in the docs:**
- **Restate: no published per-key or per-object state size limit.** The eager-state default ships a full snapshot of an object's K/V with every invocation, which implies a practical ceiling nobody has written down. Treat "state retained indefinitely" as a retention statement, not a capacity statement.
- **Cloudflare Agents SDK: "Thread-safe" and "Immediately consistent."** True by construction (single-threaded DO), but it is a property of the DO runtime, not of anything the Agents SDK adds. `setState` gives no CAS, no version, no conflict signal — "safe for concurrent updates" means serialized, not merged. Two clients doing read-modify-write on the same JSON blob still lose one update.
- **LangGraph checkpointer as "time travel".** Real capability, but it is replay-and-fork of per-thread snapshots, not a temporal query. `get_state_history` has no as-of predicate, no cross-thread scope, and the documented growth remedy is a cron job.
- **Inngest trace retention.** Pricing page and docs disagree (7 vs 14 days on Pro). Unresolvable from public sources.
- **Ray GCS fault tolerance.** Documented as a feature, then immediately narrowed: Redis backend "officially supported only if you are using KubeRay for Ray Serve fault tolerance… For other cases, you can use it at your own risk"; RocksDB backend is alpha, Linux-only, and "may change before becoming stable." Neither is a supported general-purpose HA story.
- **Restate flow control.** Real and well-specified, but gated behind `experimental-*` flags with "configuration and APIs may change in future releases."
- **`langmem`.** Marketed on the LangChain memory story; last release 2025-10-27 at version 0.0.30. Ten months without a release on a 0.0.x package is abandonware until proven otherwise.

**Benchmarks:** none of these vendors publish comparable throughput benchmarks for the state layer specifically. Temporal publishes Actions/APS (a billing unit, not a throughput measure); Cloudflare publishes a soft 1,000 req/s per object; D1 publishes an honest latency-derived rule ("if your average query takes 1 ms, you can run approximately 1,000 queries per second"). Nobody publishes a state-store benchmark. Assume every "scales horizontally" claim means *the compute scales; the per-key write path does not*.

---

## Where it breaks / what it cannot do

**All eight systems share one structural gap: none of them has a cross-actor, cross-workflow, queryable shared read model.** State is always private to an execution boundary — a workflow's history, a virtual object's key, a thread's checkpoint, an actor's instance, an object's SQLite DB. Sharing is always by *sending a message to the owner*.

- **Temporal is not a database and does not pretend to be one.** Event History is a per-execution replay log with a hard 50 MB ceiling and a default 30-day retention. Search Attributes are the only queryable surface and they cap at 40 keywords / 40 KB / 255 chars per value per namespace, are unencrypted, are read-only for business logic, and **disappear when the workflow ages out**. The Visibility read path is throttled to 30 rps and not configurable. Temporal's own docs redirect state-holding to "an external datastore through Activities." History bloat forces continue-as-new, which resets your history and therefore your ability to reconstruct anything from it. Versioning is a live hazard: the sanctioned mitigation is "Continue-As-New periodically… so you're running only a couple of versions."
- **Inngest retains almost nothing.** 32 MiB run state, 1,000 steps, 4 MiB per step return, and an event lookback of **1 hour** on entry plans / 3 days on Pro. It is a queue and a step memoizer, not a memory. `waitForEvent` losers in a parallel race leak an active pause until timeout.
- **Restate's K/V is deliberately not a shared store.** Single-key transactions; SQL read-only for introspection; **state modifiable only from inside its own virtual object**. Every cross-object read is an RPC to the owner. Eager state (the default) ships the full object snapshot on every invocation. Workflow state is destroyed at the retention boundary (default 24h). Partition count is fixed at cluster creation. Flow control is experimental.
- **LangGraph's Store has no provenance, no confidence, no validity, no versions, and no conflict handling.** `put` overwrites; item metadata is exactly `created_at` + `updated_at`. `search` truncates silently past `limit` with no overflow signal, and default ordering differs by backend. The checkpointer grows without bound and the official mitigation is a delete cron. `DeltaChannel` is beta.
- **Ray**: GCS in-memory SPOF; actor state recreated by rerunning `__init__`; at-most-once actor calls by default; `ray.put` objects permanently unrecoverable; objects fate-share with the *worker process* that owns the ref; lineage capped at 1 GB then evicted. Not a substrate for anything that must survive.
- **Dapr**: eventual consistency + last-write-wins by default, ETag OCC opt-in and sometimes *simulated* by the component; exactly one state store may back all actors, and it must be transactional and strongly consistent; actor calls always cross the network and can deadlock on circular calls; the reminder subsystem could not scale past ~hundreds of thousands of reminders for roughly 3.5 years, and the fix arrived only in v1.15. Cosmos DB and DynamoDB carry documented workflow-complexity limitations.
- **Cloudflare DO**: 10 GB per object, hard; 2 MB per row/value; ~1,000 req/s per object; a single-threaded write path; objects never relocate after creation. One alarm per object with **6 total retries** — an outage longer than the backoff window silently kills the timer forever. Duration billing charges wall-clock against 128 MB regardless of usage, which makes always-on objects expensive (their own example: $419/mo for 100 of them). PITR restores the **whole object database** to a bookmark; it cannot answer "what did fact X say on date D" without restoring or diffing. Retention is fixed at 30 days.
- **Redis Streams**: at-least-once by construction, async replication that "will not guarantee" XADD or consumer-group state is replicated, best-effort failover that "may promote a replica that lacks some data," approximate trimming with a ±30-entry fudge, and **no time-based retention at all**. Fine as a bus, disqualified as a store.
- **NATS JetStream KV — the specific ceiling that matters to us: history depth caps at 64.** That is the entire per-key version history you can keep. It is not configurable higher; it is `max_msgs_per_subject` on the backing stream. Raising it is not retroactive. It is per-key, not a bucket audit log. Per-key TTLs are create-only and are **silently dropped by a subsequent `put`** — an easy way to leak keys forever. Purge is irreversibly destructive. And a KV bucket is `discard: new`, so hitting max-bucket-size **rejects writes** rather than degrading.

---

## What we should steal

### Layer assignment: durable execution vs shared memory vs message bus (blunt)

| Concern | Owner | Evidence |
|---|---|---|
| Retry, backoff, idempotency | **Durable-execution engine** | Restate journals every `ctx.run` result and commits at quorum, so "the step will be recovered on retries and won't be re-executed" (<https://docs.restate.dev/references/architecture>); Temporal replays Event History; Inngest memoizes `step.run` by id |
| Durable timers, sleeps, schedules | **Durable-execution engine** | Temporal timers to 100 years (<https://docs.temporal.io/cloud/limits>); Inngest sleep to 1 year (<https://www.inngest.com/docs/usage-limits/inngest>). Do *not* use DO alarms for this: 6 retries total (<https://developers.cloudflare.com/durable-objects/api/alarms/>) |
| Exactly-once side effects | **Durable-execution engine** (as at-least-once + memoized journal) | Nobody offers true exactly-once. Temporal Nexus is at-least-once (<https://docs.temporal.io/nexus>); Redis says "in the general case you cannot obtain exactly once processing" (<https://redis.io/docs/latest/develop/data-types/streams/>); Ray actor calls are at-most-once by default |
| Saga compensation | **Durable-execution engine** | <https://docs.restate.dev/guides/sagas>. Note Restate's warning that `kill` skips compensation, so use `pause` on max attempts (the default) |
| Per-key single-writer serialization | **Durable-execution engine / actor runtime** | Restate virtual objects (<https://docs.restate.dev/foundations/services>), Dapr turn-based actors, Cloudflare DOs. All three give it free; rebuilding it is pure loss |
| Concurrency / rate / priority shaping | **Durable-execution engine** | Inngest's five primitives (<https://www.inngest.com/docs/guides/flow-control>); Restate's scoped rule book |
| Event fan-out, queueing, replay-to-consumers | **Message bus** | NATS JetStream consumers, Redis Streams consumer groups |
| Registry / liveness / heartbeat | **Message bus KV (NATS KV), not our store** | NATS KV per-key TTL + limit markers give expiry *and* a `PURGE` notification to every watcher on death (<https://docs.nats.io/learn/key-value/ttl-and-limits>). Heartbeats are high-churn ephemeral data; putting them in an append-only bitemporal store is a write-amplification disaster |
| **Cross-agent shared read model** | **OUR STORE** | No system here has one. Temporal says use "an external datastore through Activities"; Restate state is "modifiable only from the Virtual Object"; LangGraph checkpoints are per-thread; DO storage is per-object |
| **Historical belief queries (as-of)** | **OUR STORE** | Closest prior art is weak: DO PITR restores a whole DB to a bookmark within 30 days (<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>); NATS KV keeps **≤64** revisions per key; LangGraph `get_state_history` is a per-thread chain with no as-of predicate |
| **Contradiction detection** | **OUR STORE** | Zero prior art in any of the eight. NATS CAS *rejects* the second writer; it does not record that two claims disagree |
| **Provenance / confidence class** | **OUR STORE** | LangGraph `Item` has only `created_at`/`updated_at`; NATS KV entries carry revision + op + timestamp; DO/Agents SDK state is bare JSON. Nothing enforces provenance on write |
| **Scoped config resolution (org→project→mission→agent)** | **OUR STORE** | Restate's flow-control rule book is the closest and is worth copying wholesale (below) |

**Must NOT rebuild, under any circumstances:** durable execution and replay, retry/backoff policy, durable timers and schedules, saga compensation, cross-service at-least-once delivery with dedup, work queueing and flow control, pub/sub fan-out, and per-key single-writer serialization. Every one of these is a solved, boring, battle-tested commodity. Building any of them is how this project dies.

### Specific mechanisms to copy

1. **NATS KV's bucket-wide revision counter as assert-time.** A single server-assigned monotonic sequence across *all* writes in a bucket gives a total order comparable across keys, for free, with no clock. That is exactly the property an assert-time axis needs. Copy it: one monotonic `assert_seq` per store (or per scope), server-assigned, never client-supplied. <https://docs.nats.io/learn/key-value/history-and-revisions>
2. **NATS KV's `create` vs `update(expected_revision)` split.** `create` = CAS against "revision 0 / does not exist"; `update` = CAS against an exact revision. Two operations, both explicit, no ambiguous upsert. Our supersession write ("assert record R2 superseding R1") is literally `update(id, value, expected_revision=R1)` with a rejection when someone else already superseded R1 — and that rejection is precisely where we raise a contradiction object instead of silently retrying. <https://docs.nats.io/learn/key-value/history-and-revisions>
3. **NATS KV's delete-vs-purge distinction.** `DEL` = non-destructive marker, prior revisions still readable; `PURGE` = rollup that physically erases the subject's history. That is exactly the retract-vs-erase pair a bitemporal store needs (logical retraction for corrections, physical erasure for GDPR). Adopt both, name them the same way, and make purge loud. <https://docs.nats.io/learn/key-value/under-the-hood>
4. **Markers-as-notifications.** When a value expires or is purged, NATS writes a marker so watchers learn it is gone rather than silently drifting. Any projection we build (Linear, Discord) must receive retraction/supersession events, not just writes. Same page.
5. **Direct-read path.** NATS KV `get` is a single request to `$JS.API.DIRECT.GET.<stream>.<subject>` returning the last message on a subject — no consumer, no cursor, no ack. Our current-value read must be one indexed lookup on `(scope, entity, metric)` with no log traversal, even though the log is the truth. Same page.
6. **Restate's commit model: log is truth, materialised store is derivative.** "This cache is derivative — it can always be rebuilt from the log — and is not a second source of truth." That is the correct shape for our append-only facts + exact-first retrieval indices. Indices and embeddings are caches; the fact log is truth; any index can be dropped and rebuilt. <https://docs.restate.dev/references/architecture>
7. **Restate's epoch fencing.** Attempts carry monotonically increasing epochs and the leader rejects events from superseded epochs. Our agents will crash, get restarted, and write late. Every write must carry the agent's registry epoch; late writes from a superseded epoch get fenced, not applied. Same page.
8. **Restate's scoped rule book — take the resolution algorithm verbatim.** Patterns are `/`-separated paths where each component is exact or `*`; the most specific match wins, ranked left to right (scope, then L1, then L2), so `checkout/premium` > `checkout/*` > `*/premium`. That is our global→project→mission→agent resolution, already specified and already implemented. Also steal the warning: a `*` rule is *per-scope*, not a global pool — make our resolution semantics equally explicit in the docs. <https://docs.restate.dev/services/flow-control>
9. **Restate's scope-as-identity.** In Restate, scope namespaces the identity of everything inside it: the same idempotency key or object key under two scopes are two different things. Our record IDs should be scope-qualified for the same reason — a mission-scoped `latency_p99` and a project-scoped `latency_p99` are different facts, not a conflict.
10. **Dapr's ETag OCC contract, and its failure mode.** Read returns an ETag; write must present it; mismatch is a rejection the caller must handle. Copy the mechanism. Do **not** copy the default: Dapr's "omit the ETag and get last-write-wins" is exactly the hole we exist to close. <https://docs.dapr.io/developing-applications/building-blocks/state-management/state-management-overview/>
11. **Dapr workflow history signing.** Every history event signed with the sidecar's X.509 SPIFFE identity; verification on load; tamper → `DAPR_WORKFLOW_HISTORY_TAMPERED`; **once enabled, cannot be disabled**. A signed provenance chain with an irreversible enable flag is a strong pattern for a store whose whole value proposition is trustworthy provenance. <https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-overview/>
12. **Cloudflare's PITR bookmark format.** Opaque but **lexically comparable** strings, so `bookmark_a < bookmark_b` implies earlier-in-time by plain string comparison. Cheap, index-friendly, no clock semantics leaked. Use the same trick for our as-of tokens. <https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>
13. **Temporal's "warn then error" limit ladder.** Warn at 10 MB / 10,240 events, terminate at 50 MB / 51,200. Two thresholds, both published. Every limit we set should have a documented warn level and a documented hard level, and both should be observable before anyone hits them.
14. **Restate's `on-max-attempts: pause` default.** Failing retries pause the invocation for human resume rather than killing it and skipping compensation. For an agent substrate, park-for-human beats fail-closed. <https://docs.restate.dev/services/configuration>

---

## What we should deliberately do differently, and why

1. **Do not build our store on a durable-execution engine's state facility.** Every one of them scopes state to an execution boundary and makes cross-boundary reads an RPC to the owner. Restate is explicit: state is "modifiable only from the Virtual Object" and SQL is "only for analytics / introspection, not for updates/transactions" (<https://docs.restate.dev/guides/databases>). Restate itself tells you to use a database for "core business data… that you want to access from other services as well." Our fact store is exactly that. **Use Restate (or Temporal) for orchestration; run the store as a separate service with its own storage.** Restate's own guidance page is the argument.

2. **Make provenance a write-time schema constraint, not metadata.** LangGraph's `Item` has `created_at`/`updated_at` and nothing else; Cloudflare Agents state is bare JSON; NATS KV values are opaque bytes. In all three, provenance is something a caller may attach and usually won't. Server-side rejection of unprovenanced writes is the single feature that differentiates our store from `BaseStore`, and it must be enforced at the write path, not by convention. This is the one place where being *less* flexible than prior art is the entire point.

3. **Do not cap history depth.** NATS KV caps at **64 revisions per key**, non-configurable, non-retroactive (<https://docs.nats.io/learn/key-value/ttl-and-limits>). A store whose purpose is "what did we believe, when, and on what evidence" cannot have a 64-deep memory. Our supersession chains are unbounded by design; bound *storage* with tiering and archival, never with silent truncation of belief history.

4. **Reject-on-conflict is not enough — record the conflict.** NATS CAS rejects the losing writer and drops the write; Dapr rejects on ETag mismatch. Both discard the information that two parties disagreed. For us, a CAS failure where the incoming value **differs** from the current one is a contradiction object to be persisted, not an error to be retried away. A CAS failure where the value is **identical** is a benign retry. That distinction has no prior art here and is ours to define.

5. **Do not use a single-writer-per-object runtime as the shared store.** Cloudflare DOs, Dapr actors and Restate virtual objects all serialize on one key. That is correct for session state and catastrophic for a global fact store: DOs soft-cap at ~1,000 req/s per object and hard-cap at 10 GB (<https://developers.cloudflare.com/durable-objects/platform/limits/>), and D1 — which is literally one DO with SQL — is "inherently single-threaded" with an unraisable 10 GB ceiling (<https://developers.cloudflare.com/d1/platform/limits/>). An org-wide store partitioned per project would inherit a per-project write bottleneck and a per-project storage cliff. Use a real multi-writer database with row-level concurrency; use single-writer objects only for genuinely per-entity mutable state (an agent's session, a mission's cursor).

6. **Bitemporal from the first schema migration, never retrofitted.** Every system here that wanted history bolted it on and got something lopsided: LangGraph's fix for unbounded checkpoints is a delete cron; NATS' history is a per-subject message cap; Cloudflare's is a 30-day whole-database restore. None of them can answer "what did we believe about X as of date D, according to evidence available at that time." Two time axes plus a supersession edge in the initial schema is cheap; adding them to a live store is not.

7. **No approximate retention.** Redis `MAXLEN ~ 1000` may keep 1030 (<https://redis.io/docs/latest/develop/data-types/streams/>). Approximation is the right trade for a log and the wrong trade for a record of belief. Our retention must be exact and auditable, and erasure must be an explicit, logged, purge-class operation.

8. **Reject writes at the limit; do not evict.** NATS KV buckets are `discard: new` — an over-limit put fails loudly and existing values survive (<https://docs.nats.io/learn/key-value/under-the-hood>). Redis Streams and default JetStream streams do the opposite. We are a store, not a buffer: **fail the write, keep the facts.** Copy NATS' choice, not Redis'.

9. **Registry heartbeats do not belong in the append-only fact log.** Liveness is high-frequency, low-value, self-expiring data. NATS KV with per-key TTL and watcher markers is the right shape and already exists. Keep the *identity* of an agent/worktree/branch/webhook as a durable fact in our store; keep its *liveness* as a TTL'd key on the bus, joined at read time. Mixing them means every heartbeat is an immutable record forever.

10. **Do not adopt `langmem`, and be wary of `BaseStore` as an interface.** `langmem` is at 0.0.30 with no release since 2025-10-27 (<https://pypi.org/pypi/langmem/json>). `BaseStore` itself is a reasonable *client* shape to offer for LangGraph interop — namespaced `put/get/search` — but its data model (no versions, no provenance, silent truncation past `limit`, backend-dependent ordering) must not leak into our storage model. Offer a `BaseStore` adapter over our store; never let it define the store.

11. **Embeddings must be a labelled, droppable index — enforce that structurally.** LangGraph makes semantic search a store *mode* (`index={...}` at construction), which blurs the line between the record and its embedding. Follow Restate's discipline instead: the fact log is truth, every index is derivative and rebuildable. If a nightly job dropping and rebuilding the entire vector index changes any exact-first answer, the boundary has been violated.

12. **Publish our limits with warn-and-hard thresholds from day one.** Temporal publishes both. Restate publishes no state-size limit at all, which means every user discovers the practical ceiling in production. We will have a per-record payload limit, a per-scope record-count limit, and a supersession-chain-depth soft warning. Write them down before anyone hits them.

13. **Budget for the real cost shape.** Two published numbers should calibrate expectations. Temporal charges **$0.042/GBh for open-workflow storage vs $0.00105/GBh closed** — a 40× penalty for keeping things live (<https://temporal.io/pricing>). Cloudflare charges wall-clock duration against 128 MB whether or not an object is doing anything, which is why hibernation turns their own example from $419/mo into $20/mo (<https://developers.cloudflare.com/durable-objects/platform/pricing/>). Both say the same thing: **a persistent-agent architecture that keeps N long-lived executions or objects resident is priced as an always-on fleet.** Our design must make idle agents genuinely free — no resident workflow per agent, no resident object per mission, no polling heartbeat that keeps anything warm.
