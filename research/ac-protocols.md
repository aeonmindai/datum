# Agent Protocols & Registry Standards — adversarial prior art

Scope: agent-to-agent / agent-infrastructure **protocols** and **registry/discovery standards**.
Non-goals (other agents own these): durable execution engines; production company eng blogs; **MCP `resources/*` + subscription mechanics** (parent `AgentCoordination` covers those directly — this file deliberately does not re-derive them and covers only MCP transport, statelessness, auth, and the registry service).

All dates verified 2026-08-24.

---

## What exists

### 1. Model Context Protocol (MCP) — current revision `2026-07-28`

**The spec moved under me while I was reading it.** Current protocol version is `2026-07-28`; prior revision `2025-11-25`; earlier `2025-06-18`, `2025-03-26`, `2024-11-05`. Versioning policy is "the last date backwards incompatible changes were made" — https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning

`2026-07-28` is a **re-architecture, not a patch**. From the changelog (https://modelcontextprotocol.io/specification/2026-07-28/changelog):

- **Sessions deleted.** "Remove protocol-level sessions and the `Mcp-Session-Id` header from the Streamable HTTP transport. List endpoints (`tools/list`, `resources/list`, `prompts/list`) no longer vary per-connection. Servers that need cross-call state use explicit, server-minted handles passed as ordinary tool arguments" (SEP-2567).
- **Handshake deleted.** "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta`" (SEP-2575). The spec index now literally lists "Stateless, self-contained requests / Per-request capability negotiation" as the base protocol — https://modelcontextprotocol.io/specification/2026-07-28
- **Resumability deleted.** "Remove SSE stream resumability and message redelivery (the `Last-Event-ID` header and SSE event IDs) from the Streamable HTTP transport. A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID." The transport page states flatly: "Resumable SSE streams via `Last-Event-ID` are not supported." — https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
  - This is a **regression in delivery semantics**. In `2025-06-18` resumability was an optional-but-specified mechanism: servers MAY attach SSE event `id`s, clients SHOULD reconnect with `Last-Event-ID`, and the server "MAY use this header to replay messages that would have been sent after the last event ID, *on the stream that was disconnected*" — https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- **GET endpoint deleted**; server→client change notifications now ride a long-lived `subscriptions/listen` POST-response stream (mechanics: parent's file).
- **`ping` deleted**, along with `logging/setLevel` and `notifications/roots/list_changed`.
- **Roots, Sampling, Logging all deprecated** (SEP-2577), minimum 12-month deprecation window before removal — https://modelcontextprotocol.io/community/feature-lifecycle
- Server→client requests are gone entirely: replaced by **MRTR** (`InputRequiredResult` + client retry with `inputResponses`), SEP-2322.
- New mandatory `server/discover` RPC for up-front version/capability/identity negotiation.
- New required `ttlMs` + `cacheScope` (`"public"`/`"private"`) on `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` results (SEP-2549) — an explicit push toward **client-side caching over server push**.

**Multiple concurrent clients / shared state.** MCP `2026-07-28` does not give you shared state; it forbids the substrate you'd build it on. The resources page requires that the available set "**MUST NOT** vary per-connection or as a side effect of other requests on the connection. The set **MAY** vary by the authorization presented on the request — for example, returning only the resources the caller's granted scopes permit — since credentials are per-request input, not connection state" — https://modelcontextprotocol.io/specification/2026-07-28/server/resources. So one MCP server is legitimately shared by N clients, but every client is anonymous-per-request and the protocol carries no notion of who else is attached, no fan-out primitive, and no server-initiated write channel.

**Auth** (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
- MCP server = OAuth 2.1 resource server; normative base is **OAuth 2.1 `draft-ietf-oauth-v2-1-13`** (https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) — i.e. MCP's auth foundation is *itself still an IETF draft*.
- Clients **MUST** implement **RFC 8707** Resource Indicators and **MUST** use the canonical URI of the MCP server as the `resource` parameter (https://www.rfc-editor.org/rfc/rfc8707.html).
- Servers **MUST** implement **RFC 9728** OAuth 2.0 Protected Resource Metadata; clients **MUST** use it for AS discovery (https://datatracker.ietf.org/doc/html/rfc9728).
- **RFC 7591 Dynamic Client Registration is now deprecated** in favour of OAuth Client ID Metadata Documents (`draft-ietf-oauth-client-id-metadata-document-00`) — https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#client-id-metadata-documents
- Also new: `iss` validation per RFC 9207, mandatory `application_type` in DCR, credentials MUST be keyed by issuer identifier.

**The MCP registry** (https://github.com/modelcontextprotocol/registry) — **real, running, and narrow**:
- Go service, Postgres backing store, deployed via Pulumi to GCP/k8s (`deploy/pkg/k8s/postgres.go`, `deploy/Pulumi.gcpProd.yaml`). 7,187 stars.
- Live and answering: `GET https://registry.modelcontextprotocol.io/v0/health` → `{"status":"ok",...}` (HTTP 200, verified 2026-08-24). `GET /v0/servers?limit=2` returns real entries with `$schema: .../schemas/2025-12-11/server.schema.json`.
- It is a **metaregistry**: "MCP registries are _metaregistries_. They host metadata about packages, but not the package code or binaries" — https://github.com/modelcontextprotocol/registry/blob/main/docs/design/ecosystem-vision.md
- Namespace ownership is genuinely verified: GitHub OAuth / GitHub OIDC / DNS challenge / HTTP challenge. To publish `me.adamjones/x` you must prove `adamjones.me` — https://github.com/modelcontextprotocol/registry#authentication
- Status model is **publish-time and human-driven**, not liveness: `PATCH /v0.1/servers/{name}/versions/{version}/status` with `status` ∈ `active | deprecated | deleted` — https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md. A live query returned `"status":"active"` with `statusChangedAt == publishedAt == updatedAt` (2026-04-13) — i.e. "active" means "nobody has retracted it", not "it is up".
- `GET /v0.1/ping` and `/v0.1/health` exist but are the **registry's own** liveness, and the doc notes they "are not described in" the registry API spec proper.
- API is at **freeze v0.1** since 2025-10-24, launched preview 2025-09-08, **still not GA** — https://github.com/modelcontextprotocol/registry#development-status

**Governance:** MCP is a founding project of the Linux Foundation's **Agentic AI Foundation (AAIF)**, announced 2025-12-09 alongside Block's goose and OpenAI's AGENTS.md; platinum members AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI — https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation

### 2. Google Agent2Agent (A2A) — v1.0.0 shipped, actively maintained

- **v1.0.0 released 2026-03-12**; v1.0.1 2026-05-28; prior 0.3.0 (2025-07-30), 0.2.x. Repo `a2aproject/A2A`: 25,479 stars, 2,583 forks, 242 open issues, last push 2026-08-21, **19 commits in the trailing 30 days** (GitHub API, 2026-08-24). Not abandoned.
- Spec: https://a2a-protocol.org/latest/specification/. Normative source is **`spec/a2a.proto`** — "the single authoritative normative definition"; `spec/a2a.json` is an explicitly non-normative build artifact. Three layers: canonical data model (protobuf) → abstract operations → bindings (**JSON-RPC 2.0, gRPC, HTTP+JSON/REST**).
- Core ops: Send Message, Send Streaming Message, Get Task, **List Tasks**, Cancel Task, Get Agent Card, Subscribe to Task. `ListTasks` has cursor pagination (`pageSize` default 50, **min 1, max 100**), `statusTimestampAfter` filter, and `includeArtifacts` defaulting to false "to reduce payload size"; tasks MUST be sorted by last update time descending.
- Discovery: **Agent Card**, and the file is now `/.well-known/agent-card.json` (renamed from the earlier `agent.json`); there is a live IANA well-known URI registration template in the spec appendix, and legacy anchors/names MUST stay resolvable until the next major version.
- Agent Cards **MAY be JWS-signed (RFC 7515)** with **JCS canonicalization (RFC 8785)** before signing — a real, specified integrity story for discovery documents.
- Three update mechanisms: polling (`GetTask`), streaming (SSE), and **push notifications** (server-initiated HTTP POST to a client-supplied webhook), gated on `AgentCard.capabilities.pushNotifications` — else `PushNotificationNotSupportedError`.
- `contextId`: "an identifier that logically groups multiple related Task and Message objects." Server-generated by default and "SHOULD be treated as opaque identifiers by clients"; agents **MAY** reject a client-provided one; agents "**MAY** use the contextId to maintain internal state, conversational history, or LLM context"; agents **MAY** expire/clean up contexts.
- **Freshness for Agent Cards is plain HTTP caching**, nothing agent-specific: servers SHOULD send `Cache-Control: max-age` and an `ETag` derived from the card's `version` field or a content hash; clients SHOULD honour RFC 9111 and use `If-None-Match`/`If-Modified-Since` (§8.6).
- Governance: donated by Google to the Linux Foundation **2025-06-23** at OSS NA with AWS, Cisco, Google, Microsoft, Salesforce, SAP, ServiceNow — https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents. LF claims **>150 organizations** at the one-year mark (2026-04-09) — https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year. A2A was subsequently proposed into **AAIF** (https://github.com/aaif/project-proposals/issues/37) and reported as formally joining on **2026-08-20** — four days ago (secondary sources: https://forkast.news/googles-a2a-protocol-joins-aaif-consolidating-the-agent-economys-protocol-layer-under-one-roof/, https://www.techzine.eu/news/devops/143659/google-transfers-a2a-to-the-agentic-ai-foundation/). **I could not find a linuxfoundation.org press release confirming the 2026-08-20 A2A→AAIF transfer** — treat the exact date as secondary-sourced.

### 3. AGNTCY / Internet of Agents (Cisco origin) — most real of the "IoA" pitches

- **OASF (Open Agentic Schema Framework)** — https://github.com/agntcy/oasf (331★, Elixir, last push 2026-07-21, 254 commits). Explicitly "highly inspired from **OCSF** (Open Cybersecurity Schema Framework)… The server is a derivative work of OCSF schema server". Core is a **`record` object** annotated with **skills**, **domains**, and extensible **modules**. Schema versions are immutable once released: "no changes to that version of the schema are expected, except for non-breaking fixes". Hosted schema browser: https://schema.oasf.outshift.com/
- **Agent Directory (`dir`)** — https://github.com/agntcy/dir (177★, Go, **last push 2026-08-24**, ~1,263 files, releases at **v1.7.0**). Architecture is concrete and not vapour: "uses **content-addressing** for global uniqueness and implements **distributed hash tables (DHT)** for scalable content discovery and synchronization". Records are addressed by **CIDs** (`bafyrei…`, IPFS-style multihash) and pulls can be hash-verified: `dirctl pull "example.com/agent@bafyrei..."` "(fails on mismatch)" — https://github.com/agntcy/dir/blob/main/.skill/references/discovery.md
  - Backing stores, concretely: local `dirctl daemon` = **embedded SQLite + local OCI store** under `~/.agntcy/dir/` on `localhost:8888`; Docker Compose deployment = apiserver + reconciler + **Zot OCI registry** + **PostgreSQL**. So "distributed" in the marketing, **OCI + SQL in the actual deployment**.
  - Two distinct search scopes, which is honest: `dirctl search` (local index of the connected server) vs `dirctl routing search` (peer-to-peer network, adds `--min-score`). Trust columns are `Verified` (name ownership), `Trusted` (signature verified), `Safe` (scanners) — and the doc explicitly warns "blank when unscanned (do not conflate unscanned with unsafe)".
  - Ships SDKs (Go/Python/JS), Homebrew tap, GitHub Actions for publish/push/sign/validate records, and a Buf schema registry (https://buf.build/agntcy/dir).
- **SLIM (Secure Low-Latency Interactive Messaging)** — https://github.com/agntcy/slim (208★, **Rust**, last push 2026-08-23). Renamed from "Agent Gateway". Three planes: **Data Plane** ("forwards packets based on **hierarchical names** without inspecting application content"), **Session Layer** ("reliable delivery, end-to-end **MLS** encryption, and **group membership management**"), **Control Plane**. Positioned as transport *under* A2A and MCP, with `slim-a2a-python` and `slim-mcp-python` integrations. **This is the only thing in the entire agent-protocol landscape that ships a name-based multicast/group-membership data plane.**
- **Identity** — https://github.com/agntcy/identity (99★, Go). **Last push 2026-02-24 — six months stale** while `dir` and `slim` were pushed yesterday. The identity leg of the story is the neglected one.

### 4. Agent Network Protocol (ANP) — real documents, single-vendor energy

- https://github.com/agent-network-protocol/AgentNetworkProtocol — 1,405★, 101 forks, **523 commits**, last push **2026-08-24** (today). Not vapour; genuinely maintained.
- Specification set at **1.1**, with per-document status honestly labelled (https://raw.githubusercontent.com/agent-network-protocol/AgentNetworkProtocol/main/README.md):
  - ANP-03 `did:wba` (W3C DID method over web infra, Ed25519 `e1_` binding) — Released v1.1
  - ANP-04 WNS handles (`alice.example.com` → DID resolution, DID rotation) — Released v1.1
  - **ANP-06 Agent Communication Meta-Protocol — "Draft / not released"**. The much-cited "meta-protocol negotiation" (`anp.get_capabilities`, `anp.negotiate`) is **the one piece that has not shipped**, and the README says so plainly.
  - ANP-07 Agent Description, ANP-08 Agent Discovery ("active `.well-known` discovery and passive registration with search agents"), ANP-09 E2E instant messaging (9 profiles: core binding, identity/discovery, direct, group, direct E2EE, group E2EE with MLS leaves, attachments, federation, mentions), ANP-10 AP2 payments — all Released v1.1.
- Defensive disclaimer in the README: "This project has not issued any digital currency on any platform or blockchain."
- I grepped ANP-08 for `heartbeat|liveness|expire|ttl|status|stale` — **zero hits**. Discovery is document-fetch, not liveness.

### 5. Agent Name Service (ANS) — OWASP paper → IETF Independent Submission

- **v1 (OWASP GenAI Security Project)**: "Agent Name Service (ANS): A Universal Directory for Secure AI Agent Discovery and Interoperability", Huang, Narajala, Habler, Sheriff — https://arxiv.org/abs/2505.10609 (May 2025), DNS-inspired, PKI identity, six-component `ANSName`, protocol adapters for A2A/MCP/ACP, MAESTRO threat model. Resource page: https://genai.owasp.org/resource/agent-name-service-ans-for-secure-al-agent-discovery-v1-0/
- **v2 is the serious one**: `draft-narajala-courtney-ansv2-01`, published **2026-04-13**, expires 2026-10-15 — https://datatracker.ietf.org/doc/html/draft-narajala-courtney-ansv2-01. Authors from **GoDaddy, OWASP, DistributedApps.ai, Cisco**.
  - **Stream: "Independent Submission". Intended status: Informational. No working group.** This is not standards-track and has no IETF WG behind it.
  - Mechanism: `ans://v{version}.{agentHost}`; a **Registration Authority** verifies domain control via **ACME (RFC 8555)** DNS-01/HTTP-01, issues a **dual certificate** pair (public-CA Server Cert + private-CA Identity Cert carrying a URI SAN of the versioned ANSName — and the draft correctly notes CA/Browser Forum BR §7.1.2.7.12 forbids URI SANs in publicly trusted certs, "only a Private CA can" issue it), and seals every lifecycle event into an **append-only Transparency Log aligned with IETF SCITT**.
  - Verification tiers **Bronze (PKI) / Silver (+DANE) / Gold (+TL)**; DANE via `TLSA 3 0 1 [sha256]` requiring DNSSEC (RFC 4033); per-version `_ans-badge.{agentHost}` TXT records.
  - **Explicit lifecycle state machine**: `PENDING → PENDING_DNS → ACTIVE → {DEPRECATED, REVOKED (terminal), EXPIRED (terminal)}`, plus an `AGENT_RENEWED` TL event type where "RENEWED is a TL event type, not a distinct registration state; the agent remains ACTIVE throughout the renewal process." Control change forces `AGENT_REVOKED`.
  - **Architecturally decouples identity from discovery**: the RA publishes sealed events; independent Discovery Services build competing indexes; separate Trust Index providers publish signed VCs. Five conformance roles (RA, Discovery Service, TL operator, Trust Index provider, Verifier), and "Verification is a client-side act, not a property the RA assigns."
  - The draft is candid about the gap it's filling: MCP and A2A "define how agents communicate but explicitly defer the question of who the agent is and whether it should be trusted."

### 6. NANDA (MIT Media Lab) — the only agent registry I found with actual liveness

- Paper: "Beyond DNS: Unlocking the Internet of AI Agents via the NANDA Index and Verified AgentFacts", Raskar et al., https://arxiv.org/abs/2507.14263 (2025-07-18). Claims five guarantees incl. "**sub-second revocation and key rotation**", a **CRDT-based update protocol**, and privacy-preserving least-disclosure queries.
- **The index is live and I queried it.** `GET https://index.projectnanda.org/api/agents` (2026-08-24) returns:
  - `pagination: {page:1, limit:100, total: 13600, totalPages: 136}` — **13,600 registered agents**.
  - Per-agent fields: `id, name, description, endpoint, status, factsUrl, agentFacts, lastSeen, messageCount, specialties, category`.
  - **`status` is real and discriminating**: on page 1, **65 `online` / 35 `offline`**. `lastSeen` values spread across months (most common `8/23/2026`, `8/2/2026`, `8/24/2026`, down to `7/1/2026`).
  - Agents self-describe via a fetchable `factsUrl` (e.g. `https://…/agentfacts.json`), i.e. **AgentFacts is a well-known-style document, and the index tracks whether the endpoint is reachable.**
- Caveat: `/api/health` returns 200 but `/api/stats`, `/api/docs`, `/api/agents/register` all 404 — **I could not verify from the API whether `status`/`lastSeen` is agent-pushed heartbeat or index-side polling.** The sampled endpoints are largely on `*.onrender.com` free-tier hosts, which cold-start and would look "offline" under polling.

### 7. ACP (IBM/BeeAI) — dead, absorbed

- Launched by IBM Research March 2025 for the BeeAI platform; donated to LF that same month; **merged into A2A announced 2025-08-29** — https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/ and https://github.com/orgs/i-am-bee/discussions/5 ("ACP is officially merging with the A2A under the Linux Foundation umbrella"; "The BeeAI platform, previously powered by ACP, now uses A2A").
- IBM's own docs now carry a wind-down notice: "The ACP team is winding down active development and contributing its technology and expertise to A2A, which may impact the relevance and accuracy of this content" — https://www.ibm.com/think/topics/agent-communication-protocol
- **Consequence:** any ANS/AGNTCY/comparison doc still listing "A2A, MCP, ACP" as three live protocols is citing a one-year-stale landscape. That includes the OWASP ANS v1 protocol-adapter layer.

### 8. IETF landscape — no working group, all individual drafts

Queried the Datatracker API for drafts with "agent" in the name. Every AI-agent-relevant item is an **individual submission with no WG**, and the whole cohort is <10 months old:

| Draft | Rev | Last activity | Title |
|---|---|---|---|
| `draft-chen-agent-decoupled-authorization-model` | 00 | 2026-08-18 | A Decoupled Authorization Model for Agent2Agent |
| `draft-cui-ai-agent-task` | 01 | 2026-07-03 | Task-oriented Coordination Requirements for AI Agent Protocols |
| `draft-howe-vcon-agent-session` | 00 | 2026-05-20 | vCon Agent Session |
| `draft-zheng-dispatch-agent-identity-management` | 00 | 2026-05-07 | Agent Identity Management |
| `draft-narajala-courtney-ansv2` | 01 | 2026-04-13 | Agent Name Service v2 |
| `draft-narvaneni-agent-uri` | 03 | 2026-04-18 | The `agent://` Protocol — A URI-Based Framework for Interoperable Agents |
| `draft-liu-agent-context-protocol` | 00 | 2026-01-26 | Agent Context Protocol |
| `draft-huang-acme-scalable-agent-enrollment` | 00 | 2025-12-16 | Extending Certificate Enrollment Protocols for Scalable Agentic AI Identity |

Source: https://datatracker.ietf.org/api/v1/doc/document/?name__contains=agent&type=draft — and the human view, e.g. https://datatracker.ietf.org/doc/draft-narajala-courtney-ansv2/. Note the only rev-03 in the AI cohort is `agent-uri`. **There is no `ietf-`prefixed AI-agent draft, i.e. nothing WG-adopted.**

### 9. Existing service-discovery standards that already solve liveness

- **etcd Lease API** — "Leases are a mechanism for detecting client liveness. The cluster grants leases with a time-to-live. A lease expires if the etcd cluster does not receive a keepAlive within a given TTL period… each key may be attached to at most one lease. **When a lease expires or is revoked, all keys attached to that lease will be deleted.** Each expired key generates a delete event in the event history." `LeaseGrant(TTL)` returns a *server-selected* TTL; refresh via the bidirectional `LeaseKeepAlive` stream — https://etcd.io/docs/v3.6/learning/api/
- **Consul TTL health checks** — "TTL checks wait for an external process to report the service's state to a Consul `/agent/check` HTTP endpoint. If the check does not receive an update before the specified `ttl` duration, the check logs the service as critical." Endpoints `pass`/`warn`/`fail`/`update`; checks default to **critical** on registration "to prevent services from registering as passing… before their health is verified"; TTL status is **persisted to disk** across agent restarts — https://developer.hashicorp.com/consul/docs/register/health-check/vm
- **Kubernetes Lease API** (`coordination.k8s.io`) — "every kubelet heartbeat is an update request to this Lease object, updating the `spec.renewTime` field… The Kubernetes control plane uses the time stamp of this field to determine the availability of this Node." One `Lease` per Node in the `kube-node-lease` namespace; also used for leader election and (v1.26+, beta) kube-apiserver identity via `apiserver-<sha256>` leases labelled `apiserver.kubernetes.io/identity=kube-apiserver` — https://kubernetes.io/docs/concepts/architecture/leases/
- **Erlang/OTP `global`** — "A global name registration facility… Registration of global names / Global locks / Maintenance of the fully connected network". The global name server **monitors the registered pid** and subscribes to `nodeup`/`nodedown`, so death deregisters automatically. As of **OTP 25** `global` by default prevents overlapping partitions — https://www.erlang.org/doc/apps/kernel/global.html
- **Ray** — named/detached actors with `max_restarts` (default `0`, `-1` = infinite) for automatic restart on crash; GCS fault tolerance requires external Redis (or alpha embedded RocksDB) — https://docs.ray.io/en/latest/ray-core/fault_tolerance/actors.html

---

## What is proven vs claimed

**Proven (I executed or read normative text):**
- MCP registry is a live Postgres-backed Go service; `/v0/health` → 200; namespace ownership verified via GitHub OIDC / DNS / HTTP challenge. Its status field is editorial, not observed.
- MCP `2026-07-28` removed sessions, the handshake, `ping`, the GET stream, and `Last-Event-ID` resumability — all four stated in the normative changelog and transport page, with SEP numbers.
- MCP auth mandates RFC 8707 + RFC 9728 and deprecates RFC 7591 DCR.
- A2A v1.0.0/v1.0.1 exist; 19 commits in 30 days; `.well-known/agent-card.json`; JWS+JCS card signing; `ListTasks` pageSize max 100; push-notification webhooks capability-gated.
- AGNTCY `dir` v1.7.0 ships CID-addressed records with hash-verified pulls, DHT routing, Zot OCI + Postgres deployment; SLIM ships a Rust hierarchical-name data plane with MLS group membership.
- ANP has 523 commits and ships v1.1 for identity/naming/description/discovery/messaging/payments; **ANP-06 meta-protocol is self-declared "Draft / not released."**
- ANS v2 is an **Independent Submission, Informational**, no WG, expiring 2026-10-15; its lifecycle state machine and dual-cert/SCITT-TL design are as described in the draft text.
- **NANDA index really tracks liveness**: 13,600 agents, `status` split 65/35 online/offline on page 1, `lastSeen` spread over months. This is a measured fact from the live API.
- ACP is deprecated and merged into A2A (LF AI & Data announcement + IBM's own wind-down notice).
- etcd/Consul/K8s/Erlang liveness mechanics are quoted from primary docs.

**Claimed but unverified by me:**
- NANDA's "sub-second revocation and key rotation" and CRDT update protocol — paper claims; **the live API exposes no endpoint that would let me test either**, and I could not determine whether `status` is push-heartbeat or index-poll.
- A2A's ">150 organizations" and "active production deployments across multiple industries" — LF press-release framing with no per-org verification, and "supporting the standard" is not "running it in production".
- A2A joining AAIF on **2026-08-20** — reported by Forkast/Techzine/CryptoRank; **no linuxfoundation.org press release found**. The LF-side artefact I could confirm is the project proposal issue (https://github.com/aaif/project-proposals/issues/37).
- AGNTCY `dir`'s "distributed peer-to-peer network" at scale — the code and CLI are real, but every documented deployment path is a single apiserver over SQLite or Postgres+Zot. **No public evidence of a running multi-operator DHT with meaningful record counts.** AGNTCY star counts (99–331) are 2 orders of magnitude below A2A's 25.5k; this is a well-engineered project with almost no adoption.
- OASF/`dir` "Verifiable Claims… cryptographic mechanisms for data integrity and provenance tracking" — signing and CID verification are implemented; the *semantic* provenance claim (what a capability assertion means) is unvalidated, and the docs concede capabilities "are often subjectively evaluated".
- OWASP ANS v1's ZKP-based capability validation — described in the paper; I found no implementation.

**Stale / dead:**
- `agntcy/identity` last pushed **2026-02-24** (6 months) while sibling repos ship daily.
- ANP-06 meta-protocol: still unreleased after ~22 months of repo history.
- ACP: dead. Anything treating it as live is stale.
- MCP HTTP+SSE transport: deprecated since `2025-03-26`, reclassified formally Deprecated in `2026-07-28` (SEP-2596).
- MCP Roots/Sampling/Logging: newly deprecated; do not build on them.

---

## Where it breaks / what it cannot do

**MCP as transport for a shared-memory substrate with hundreds of agents — blunt verdict: no. Use it as a facade, never as the substrate.** Precise failure points:

1. **No delivery guarantee, and it got worse on purpose.** `2026-07-28` removed SSE event IDs and `Last-Event-ID`: "A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID." For an append-only fact store, a lost stream means an unknown gap. There is no cursor, no offset, no replay, no at-least-once. Our bitemporal log needs *resumable, ordered, gap-detectable* reads; MCP `2026-07-28` deleted the one mechanism that offered it.
2. **Change notifications carry no payload and no version.** `notifications/resources/updated` carries a URI. Every notified client must re-`read`, so N agents watching one fact = N reads per write, and there is no way to tell whether you read the version that triggered your notification or a later one. Fan-out cost is O(N) reads, not O(N) pushes, and it is racy.
3. **No fan-out primitive and no server-initiated write.** Servers cannot push a fact to an agent that has no open listen stream, and MRTR explicitly *removed* server-initiated requests. Mission assignment ("agent 7: your target changed") is unrepresentable as a protocol operation; you'd tunnel it through a tool call the agent must poll for.
4. **Statelessness is now normative, so "who is connected" is unrepresentable.** Sessions and `Mcp-Session-Id` are gone; lists "MUST NOT vary per-connection"; `ping` is gone. There is no protocol-level identity for a connected agent, no presence, no heartbeat, nothing to hang a lease on. A registry with heartbeats cannot be expressed in MCP `2026-07-28` — it would have to live entirely inside tool arguments and server-minted opaque handles, which is exactly what SEP-2567 tells you to do and is not a protocol feature.
5. **Subscription filters are enumerated URIs.** `resourceSubscriptions: string[]` is a list of exact URIs. Hundreds of agents × thousands of facts, with no prefix/wildcard/query subscription, means either enormous filter arrays or per-agent polling. (Mechanics: parent's file.)
6. **The spec is a moving target and just broke compatibility.** Four revisions in 21 months, and the newest deleted the handshake, sessions, resumability, `ping`, Roots, Sampling, and Logging. Building our substrate's wire protocol on MCP means re-doing the transport layer roughly annually. Its auth foundation (OAuth 2.1) is itself still `draft-13`.
7. **Caching is the sanctioned freshness model, and it is unsound for us.** Required `ttlMs`/`cacheScope` means intermediaries may serve `cacheScope: "public"` list responses to other callers. A contradiction-detecting fact store cannot tolerate a proxy serving a stale "current value" — you'd have to mark everything `private` with `ttlMs: 0` and fight the grain of the protocol.

**A2A: no shared state, by explicit design.** The spec's own goal statement is to let agents exchange information "**without needing access to each other's internal state, memory, or tools**". `contextId` is *not* shared context: it is server-generated, opaque to clients, agents MAY refuse a client-supplied one, and it groups tasks *within one agent's* store — "Agents MAY use the contextId to maintain internal state". Two agents cannot read the same `contextId`-keyed state; there is no A2A operation to do so. Everything is point-to-point RPC over tasks. Additional gaps: no registry standard at all (§8.2 offers one line — "Registries/Catalogs: Querying curated catalogs of agents" — and defines nothing); no heartbeat, presence, or TTL (freshness for Agent Cards is `Cache-Control`/`ETag` per RFC 9111); `ListTasks` caps at 100/page; no provenance or confidence model anywhere in the data model.

**AGNTCY:** `dir` is a *record* directory, not a node registry. Records are immutable CID-addressed artefacts; there is no heartbeat, no lease, no `lastSeen`. Publishing an agent record says "this thing was described", never "this thing is up". `oasf` schema immutability is good for reproducibility and bad for a live registry where nodes change state constantly. `identity` — the leg you'd need for per-agent auth — is 6 months stale. And the adoption gap (177★ on `dir` vs 25.5k on A2A) means betting on OASF as an interchange schema is betting on a schema almost nobody speaks.

**ANP:** DID-based identity is genuinely the most principled identity story here, but the meta-protocol negotiation that makes ANP interesting is **unreleased**, discovery has no liveness concept, and the entire suite has one primary sponsor. E2EE (MLS) on group messaging actively *fights* a shared-memory substrate: if the server can't read the payload, it can't index facts, detect contradictions, or enforce provenance server-side.

**ANS v2:** the best-designed thing in this whole survey and **the wrong timescale**. ACME domain validation, dual certs, and SCITT transparency logs operate on certificate lifetimes. Our worktrees and agent processes live for minutes. `AGENT_RENEWED` is a certificate renewal, not a 10-second heartbeat. Also: Independent Submission, Informational, no WG, expires 2026-10-15, and requires DNSSEC for its Silver/Gold tiers — which most orgs do not have. Its ANSName is version-anchored (`ans://v{version}.{agentHost}`), so "every change to an agent's software or capabilities requires a new version number and a new registration" — unusable for a git worktree that changes every commit.

**NANDA:** has the liveness we want and little else we want. No provenance model, no confidence classes, no bitemporality, no contradiction detection. `messageCount` and `specialties` are marketplace metadata. The index is a discovery directory for public agents; several sampled endpoints are free-tier Render hosts, and the 35% `offline` rate on page 1 is itself evidence that a poll-based liveness signal over hobby infrastructure is noisy. And I could not verify the headline paper claims from the live API.

**The whole field's shared blind spot:** every one of these treats an **agent** as the only node type, and treats **discovery** (find a capable agent) as the problem. None models a git worktree, a branch, or a webhook as a first-class addressable node. None has a provenance/confidence field on a record. None has valid-time vs assert-time. None has a contradiction object. The agent-protocol ecosystem is solving "which vendor's agent should I call", not "what does my org currently believe and how sure is it".

---

## Direct answer: is there ANY registry standard where agents, git worktrees, git branches, and webhooks are all first-class nodes with heartbeats/leases?

**No. Nothing close. Not in any agent protocol, and not in any general standard.** Blunt breakdown:

- **In agent-land: nothing.** MCP registry = publish-time metaregistry of *servers*, status hand-edited, no liveness. A2A = no registry standard whatsoever. AGNTCY `dir` = immutable CID records, no liveness. ANP-08 = `.well-known` document fetch, zero liveness vocabulary. ANS v2 = certificate-lifetime lifecycle, agents only, version-anchored names. NANDA = **the only one with liveness at all** (`status`, `lastSeen`, 13,600 agents), and agents only. **Zero of them model a repo, a branch, or a webhook as a node.**
- **In infra-land: the mechanisms exist but the heterogeneity does not.** The closest analogues, with their exact mechanism:

| System | Mechanism | Heterogeneous nodes? |
|---|---|---|
| **etcd leases** — https://etcd.io/docs/v3.6/learning/api/ | `LeaseGrant(TTL)` → server-selected TTL; refresh via bidirectional `LeaseKeepAlive` stream; **on expiry every key attached to the lease is deleted and emits a delete event** | **Yes — keys are arbitrary.** This is the single closest fit: any node type is just a key, and liveness is a lease. |
| **Consul services + checks** — https://developer.hashicorp.com/consul/docs/register/health-check/vm | TTL check: external process PUTs to `/agent/check/{pass,warn,fail,update}`; no update within `ttl` → **critical**; checks start critical by default; status persisted to disk | Partly — "service" is the only first-class node type, but checks can be registered for arbitrary things. |
| **Kubernetes Lease API** — https://kubernetes.io/docs/concepts/architecture/leases/ | `Lease` object in `coordination.k8s.io`; holder updates `spec.renewTime`; control plane reads the timestamp to decide availability; one per Node in `kube-node-lease` | No — leases are for Nodes/leader-election/apiserver identity. But `Lease` is a plain object you can create for anything. |
| **Erlang/OTP `global`** — https://www.erlang.org/doc/apps/kernel/global.html | Name→pid registry; name server **monitors the pid** and subscribes to `nodeup`/`nodedown`, so death auto-deregisters; OTP 25+ prevents overlapping partitions | No — pids only. But liveness is exact (process death, not timeout). |
| **Ray actors** — https://docs.ray.io/en/latest/ray-core/fault_tolerance/actors.html | Named/detached actors in the GCS; `max_restarts` (default 0, -1 = infinite) auto-restart on crash; GCS FT needs external Redis | No — actors only. |

**Practical conclusion: the closest existing thing to what we want is etcd leases** — because a lease is decoupled from what it keeps alive, so `agent/…`, `worktree/…`, `branch/…`, `webhook/…` can all be lease-attached keys under one uniform liveness mechanism, with automatic deletion + a delete event on expiry. Consul's TTL-check semantics (start critical, external push, persist across restart) is the best *policy* design. Nobody has unified the two into a heterogeneous agent-infrastructure registry. **We would be building something that does not exist — and that is a legitimate reason to build it, not a red flag, provided we steal the lease mechanism instead of inventing one.**

---

## What we should steal

1. **etcd's lease indirection, verbatim in spirit.** One `Lease(TTL)` primitive; every node type (agent, worktree, branch, webhook) is a key that *attaches* to a lease. Expiry deletes attached keys and **emits an event**. That single design decision is what makes a heterogeneous registry possible, and it's proven at scale. (https://etcd.io/docs/v3.6/learning/api/)
2. **Consul's check policy.** Register **critical by default** — a node is not live until it proves it ("prevents services from registering as passing… before their health is verified"), external process pushes `pass/warn/fail`, and status **persists across restart**. The three-state `pass/warn/fail` is better than a boolean for agents that are alive-but-wedged. (https://developer.hashicorp.com/consul/docs/register/health-check/vm)
3. **Kubernetes' `renewTime` representation.** Store the heartbeat as a *timestamp the holder writes*, not a countdown the server decrements. It makes staleness computable by any reader, is trivially bitemporal-compatible (`renewTime` is valid-time; the write is assert-time), and survives clock-skew debates better than TTL arithmetic.
4. **ANS v2's separation of identity from discovery, and its append-only transparency log.** "The RA publishes sealed events; independent Discovery Services build competitive indexes"; every lifecycle transition is a sealed TL event; "Verification is a client-side act, not a property the RA assigns." This is exactly our event-log-plus-projections shape, and it validates our "human tools are downstream projections" stance with a security argument. Steal also the **explicit lifecycle state machine** with a distinguished `RENEWED` *event* that does not change *state*. (https://datatracker.ietf.org/doc/html/draft-narajala-courtney-ansv2-01)
5. **ANS v2's tiered assurance (Bronze/Silver/Gold).** A client-selectable assurance level "appropriate to transaction risk" is precisely our confidence-class idea generalised: don't just label confidence, let the *reader* declare the minimum tier it will accept. Our retrieval API should take a minimum-confidence parameter.
6. **A2A's signed discovery documents.** JWS (RFC 7515) over **JCS-canonicalized** (RFC 8785) JSON, with signature-stable field-presence rules. If we ever publish agent/mission descriptors outside our trust boundary, this is the done-right recipe — and JCS is the detail everyone gets wrong.
7. **AGNTCY's content-addressing with fail-on-mismatch fetch.** `dirctl pull "name@bafyrei..."` "fails on mismatch". Our append-only records should be CID-addressable so a "superseded by id X" pointer is cryptographically verifiable rather than merely referential.
8. **OASF's OCSF lineage and immutable schema versions.** Reusing a battle-tested security-schema *methodology* (attribute-based taxonomies, `record` + skills/domains/modules, extensions with validation, "once released, no structural changes") beats inventing a schema framework. Note the split: **immutable schema versions, mutable facts** — that's the right seam.
9. **MCP's `ttlMs` + `cacheScope` distinction.** Not for our facts, but the `"public"` vs `"private"` axis on every response is a genuinely good idea we should carry on *projections* so a shared cache never serves scoped data across tenants.
10. **NANDA's `status` + `lastSeen` on every directory row.** Trivially cheap, and it is the single feature that separates a directory that tells you something from a directory that tells you nothing. Every node row in our registry should render both.
11. **MCP's namespace-ownership proof for publishing.** GitHub OIDC / DNS / HTTP challenge to claim a namespace (`me.adamjones/*` requires proving `adamjones.me`) is the right anti-squatting model if we ever federate.
12. **Erlang `global`'s monitor-not-timeout insight.** Where we *can* observe death directly (a local process, a subprocess we spawned), do that instead of waiting out a TTL. Reserve leases for things we can only observe remotely.

## What we should deliberately do differently, and why

1. **Do not adopt MCP as the substrate transport.** Expose an MCP facade for agent *tool* access if we want IDE/host compatibility, but the wire protocol for the fact store must be ours. Reasons, concretely: no replay/resume after `2026-07-28` deleted `Last-Event-ID`; notifications carry a URI and no version, forcing O(N) racy re-reads; no server-initiated write or fan-out (MRTR removed server-initiated requests); statelessness is now normative so presence/heartbeat is unrepresentable; and the spec has broken compatibility four times in 21 months. **We need resumable ordered reads with a cursor — that is table stakes for an append-only log and MCP explicitly does not have it.**
2. **Make the log the interface, not a notification.** Every reader gets a **monotonic cursor** into the event log and can resume from an offset, detect gaps, and replay. This is the direct inversion of MCP's "here's a URI, go re-read, good luck". It also gives contradiction detection a deterministic input: two records are compared as of a log position, not as of whatever two racing reads returned.
3. **Push the payload, not a poke.** Notifications carry the new record (or at minimum its id + assert-time + supersedes-pointer). MCP's URI-only notification is the reason its fan-out is O(N) reads; we should not reproduce it.
4. **Reject the A2A "opaque execution" premise for internal agents.** A2A is built for *cross-organizational* agents that must not see each other's state — hence no shared-state primitive, and `contextId` being opaque and single-agent-scoped. Inside one org, shared state is the entire point. So: use A2A shapes only at our external boundary, and never let its "agents don't share memory" axiom leak into our internal design. If we ever speak A2A outward, expose missions as A2A tasks and treat `contextId` as a *foreign key into our mission id*, not as our context store.
5. **Heterogeneous nodes with one lease mechanism from day one.** Do not build an agent registry and bolt worktrees/branches/webhooks on later. Every agent protocol surveyed made "agent" the only node type and consequently has no vocabulary for anything else. A single `(node_id, kind, lease_id, renew_time, status)` shape with `kind ∈ {agent, worktree, branch, webhook, …}` costs nothing now and is a rewrite later.
6. **Heartbeats on a seconds-to-minutes timescale, decoupled from identity.** ANS v2 conflates liveness with certificate lifecycle; that's right for a payment counterparty and catastrophically wrong for a worktree. Split them: **identity** is long-lived and cryptographic; **liveness** is a short lease that expires constantly and noisily. Never let losing a lease revoke an identity.
7. **Do not build DHT/P2P discovery.** AGNTCY built the most credible content-addressed DHT directory in this space and it has 177 stars, and every documented deployment collapses to a single apiserver over SQLite or Postgres+Zot. A single authoritative Postgres with append-only semantics is strictly simpler and strictly more consistent. **Steal the CIDs; skip the DHT.**
8. **Do not encrypt payloads end-to-end.** ANP's MLS profiles are elegant and would destroy us: a server that cannot read facts cannot index them, cannot detect contradictions, and cannot enforce provenance-on-write. Encrypt in transit and at rest; keep the server semantically privileged. This is a deliberate trade of E2EE for server-side invariant enforcement.
9. **Do not mint a new naming scheme or URI protocol.** `ans://`, `agent://` (`draft-narvaneni-agent-uri-03`), ANP's WNS handles, ANS's `ANSName`, OASF CIDs — five incompatible naming schemes, none adopted, none WG-backed. Use plain URLs plus our own opaque ids and DNS for the rare federation case. Naming is where this ecosystem goes to die.
10. **Version-anchored names are wrong for us.** ANS requires "every change to an agent's software or capabilities requires a new version number and a new registration". A worktree changes every commit. Our node identity must be **stable across content change**, with version/commit as an *attribute* — the opposite of ANS's design.
11. **Provenance and confidence are mandatory columns, and we're on our own.** Not one surveyed protocol has a confidence class or an evidence field on a record; AGNTCY comes closest and its own docs concede capabilities "are often subjectively evaluated". There is no standard to conform to, so define ours cleanly and don't wait for one. Server-side rejection of unprovenanced writes is the invariant no external protocol will give us.
12. **Do not use HTTP caching for fact freshness.** A2A leans on `Cache-Control`/`ETag`/RFC 9111 for Agent Cards and MCP now requires `ttlMs`/`cacheScope` on list results. For a contradiction-detecting store, an intermediary serving a stale "current value" is a correctness bug, not a latency win. Facts are `no-store`; only *projections* get TTLs.
13. **Don't chase the standards. Track exactly two.** Governance is consolidating fast: MCP into AAIF (2025-12-09), A2A into LF (2025-06-23) and reportedly AAIF (2026-08-20), ACP dead (2025-08-29). The IETF has **no working group** and eight individual drafts, the oldest AI-relevant one from 2025-12. Anything we implement against a non-WG Informational draft expiring in October is a liability. Watch MCP and A2A; implement neither as substrate.

---

### Corrections to likely-stale assumptions
- **MCP is not at `2025-06-18`.** It is at `2026-07-28`, and that revision is stateless, session-less, handshake-less, and non-resumable.
- **ACP is not a live third protocol.** Merged into A2A 2025-08-29; IBM's docs carry a wind-down notice.
- **A2A's discovery file is `.well-known/agent-card.json`**, not `agent.json`, and A2A is at **v1.0.x**, not 0.2/0.3.
- **AGNTCY's "Agent Gateway" is now SLIM.**
- **MCP's Roots, Sampling, and Logging are deprecated** as of `2026-07-28` — do not design against them.
