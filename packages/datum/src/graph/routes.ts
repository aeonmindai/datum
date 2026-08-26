import type { FastifyInstance, FastifyRequest } from "fastify";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { authenticateKey, requirePermission, requireScope, type AuthedKey } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { impact, indexScope, ingestGraph, resolveIndex, searchSymbols } from "./store.js";
import { EDGE_KINDS, GraphArtifactSchema, type EdgeKind } from "./types.js";

/**
 * The code graph's HTTP surface: two reads, and one write.
 *
 * `sendRejection` is reused rather than reinvented: it is the one place a refusal turns into a
 * body, and it already knows not to write a rejection row for a GET.
 *
 * The write route is why this file is not symmetric. An artifact is three orders of magnitude
 * larger than any other body this server accepts, arrives compressed, and comes from a git hook
 * rather than an agent — so it gets its own encapsulated context with its own body limit and its
 * own parser, and nothing about the rest of the server moves to accommodate it.
 */

const ImpactQuery = z.object({
  repo: z.string().min(1),
  symbol: z.string().min(1),
  // Bounded here as well as in `impact()`; the library check is the authority, this one just
  // produces a field-named 400 instead of a generic one.
  depth: z.coerce.number().int().min(1).max(8).optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "commit must be 7-40 lowercase hex")
    .optional(),
  /** Comma-separated edge kinds. "who *calls* this" and "who *imports* this" are different
   *  questions and the closure function already takes the filter. */
  kinds: z.string().min(1).optional(),
});

const SymbolQuery = z.object({
  repo: z.string().min(1),
  q: z.string().min(1),
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, "commit must be 7-40 lowercase hex")
    .optional(),
  // Present so the response is bounded rather than as a feature; `searchSymbols` clamps it too.
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const IndexQuery = z.object({
  /** Mirrors `datum ingest-graph --scope`. Without it the index lands under the org's project
   *  tree, which is what a git hook posting its own repo wants. */
  scope: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "scope must be slash-separated labels")
    .optional(),
});

/**
 * The ceiling for one artifact, and the only place in this server where 1 MiB is not enough.
 *
 * Arc's artifact is 35,326,574 bytes of JSON — 33.69 MiB, 19,177 symbols, 102,450 edges, measured
 * rather than estimated. The global limit in `http/server.ts` is 1 MiB and would reject it before
 * any handler ran, so this route raises its own and leaves that one alone: one large route is a
 * decision, a large default is an accident.
 *
 * 64 MiB is a little under twice the largest artifact anyone has produced, so a repo half again
 * the size of Arc still lands, and it doubles as the inflated-size ceiling below — which is what
 * stops a 2 MiB gzip body from becoming a gigabyte of heap.
 */
const ARTIFACT_BYTE_LIMIT = 64 * 1024 * 1024;

/** Off the event loop: inflating Arc's artifact is ~35 MB of work, and the sync call would hold
 *  every other request for the duration. */
const inflate = promisify(gunzip);

/**
 * Bytes on the wire to an artifact-shaped `unknown`.
 *
 * gzip is accepted because the uncompressed artifact is tens of megabytes and compresses 16x
 * (Arc: 33.69 MiB down to 2.09 MiB), which is the difference between a git hook that can post
 * from a laptop and one that cannot. `identity` and gzip are the only encodings: anything else is
 * refused by name rather than left to fail as unparseable JSON.
 */
async function decodeArtifact(body: unknown, encoding: string | undefined): Promise<unknown> {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new Rejection({
      reason: "malformed_request",
      message: "POST /v1/graph/index needs an artifact body: the JSON `datum index --emit` writes.",
      detail: { bytes: Buffer.isBuffer(body) ? body.length : 0 },
    });
  }

  const named = (encoding ?? "identity").trim().toLowerCase();
  let json = body;
  if (named === "gzip" || named === "x-gzip") {
    try {
      json = await inflate(body, { maxOutputLength: ARTIFACT_BYTE_LIMIT });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      throw new Rejection({
        reason: "malformed_request",
        message:
          code === "ERR_BUFFER_TOO_LARGE"
            ? `gzip body inflates past the ${ARTIFACT_BYTE_LIMIT}-byte ceiling for one artifact`
            : "content-encoding: gzip was declared but the body is not gzip",
        detail: { encoding: named, compressed_bytes: body.length, limit: ARTIFACT_BYTE_LIMIT },
      });
    }
  } else if (named !== "identity") {
    throw new Rejection({
      reason: "malformed_request",
      message: `content-encoding ${JSON.stringify(named)} is not supported; send identity or gzip`,
      detail: { encoding: named, supported: ["identity", "gzip"] },
    });
  }

  try {
    return JSON.parse(json.toString("utf8"));
  } catch (err) {
    throw new Rejection({
      reason: "malformed_request",
      message: `artifact body is not JSON: ${(err as Error).message}`,
      detail: { bytes: json.length, encoding: named },
    });
  }
}

/**
 * Mirrors the helper of the same name in `http/v1.ts`. It is not exported there and this module
 * does not own that file, so the shape is repeated rather than a second error convention invented.
 */
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "query"}: ${i.message}`)
        .join("; "),
      detail: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

function parseKinds(raw: string | undefined): EdgeKind[] | undefined {
  if (!raw) return undefined;
  const parsed = z.array(z.enum(EDGE_KINDS)).min(1).safeParse(raw.split(",").map((s) => s.trim()));
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: `kinds must be a comma-separated subset of ${EDGE_KINDS.join(",")}`,
      detail: { kinds: raw },
    });
  }
  return parsed.data;
}

export function registerGraphRoutes(app: FastifyInstance, deps: { db: Db; config: Config }): void {
  const { db } = deps;

  app.get("/v1/impact", async (request, reply) => {
    try {
      // Authenticate BEFORE validating input. This is the ordering rule stated in `http/v1.ts`:
      // parsing first lets an anonymous caller map the request schema by reading 400s.
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const query = parse(ImpactQuery, request.query);
      const kinds = parseKinds(query.kinds);

      // A key is bound to a scope subtree and the scope lives on the index row, so which index
      // answers has to be settled before the caller can be authorised for it. Same order as
      // GET /v1/why/:id: resolve the row, then check the scope, then do the work.
      const index = await resolveIndex(db, { repo: query.repo, commitSha: query.commit });
      requireScope(key, index.scope);

      // The resolved commit is passed down rather than the caller's (possibly absent) one. Without
      // it an unqualified request would resolve "newest completed index" twice, and an ingest
      // landing between the two calls would mean the scope that was authorised is not the scope
      // that answered — a re-ingest under a different scope would then be readable by a key that
      // was never granted it.
      const result = await impact(db, {
        repo: query.repo,
        symbol: query.symbol,
        commitSha: index.commit_sha,
        depth: query.depth,
        kinds,
      });
      return reply.send({
        ok: true,
        // Provenance the closure itself does not carry: which index answered, and when it was
        // built. `repo` and `commit_sha` are already on `result` and are not repeated.
        index: {
          id: index.id,
          scope: index.scope,
          indexer: index.indexer,
          indexed_at: index.indexed_at,
          symbol_count: index.symbol_count,
          edge_count: index.edge_count,
        },
        ...result,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.get("/v1/graph/symbols", async (request, reply) => {
    try {
      const key = await authenticateKey(db, request.headers.authorization);
      requirePermission(key, "read");
      const query = parse(SymbolQuery, request.query);

      const index = await resolveIndex(db, { repo: query.repo, commitSha: query.commit });
      requireScope(key, index.scope);

      const found = await searchSymbols(db, {
        repo: query.repo,
        q: query.q,
        // Pinned for the same reason as above.
        commitSha: index.commit_sha,
        limit: query.limit,
      });
      return reply.send({
        ok: true,
        index: {
          id: found.index.id,
          scope: found.index.scope,
          repo: found.index.repo,
          commit_sha: found.index.commit_sha,
          indexer: found.index.indexer,
          indexed_at: found.index.indexed_at,
        },
        symbols: found.symbols,
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  /**
   * POST /v1/graph/index — refresh the graph without database access.
   *
   * This is what makes indexing automatable: `datum ingest-graph` needs DATABASE_URL, so a git
   * hook or a CI runner outside the database's network could not refresh a deployed instance at
   * all. It runs in its own encapsulated context, and each piece of that is load-bearing:
   *
   * - The body limit is 64 MiB here and 1 MiB everywhere else (see ARTIFACT_BYTE_LIMIT).
   * - The parser hands the handler raw bytes. Decoding happens in the handler so that a bad
   *   encoding, a zip bomb and unparseable JSON all come back as the same machine-readable
   *   refusal shape as everything else, instead of Fastify's default error body.
   * - Authentication happens in an `onRequest` hook, which is the only place it *can* happen
   *   before the body is read. Everywhere else in this server "authenticate before parsing" is
   *   just an ordering inside the handler; on a route that will buffer 64 MiB it has to be a hook,
   *   or a stranger gets to make the server read 64 MiB before being told no.
   */
  app.register(async (branch) => {
    // Scoped to this child context, which is what `app.register` encapsulates: the reads above
    // and every other route in the server keep the default JSON parser and the global limit.
    branch.removeAllContentTypeParsers();
    branch.addContentTypeParser<Buffer>(
      "*",
      { parseAs: "buffer", bodyLimit: ARTIFACT_BYTE_LIMIT },
      (_request, body, done) => {
        done(null, body);
      },
    );

    /** Filled by the hook below, read by the handler. A WeakMap rather than a request decorator:
     *  the key belongs to this one route and not to every request the server serves. */
    const authed = new WeakMap<FastifyRequest, AuthedKey>();

    branch.addHook("onRequest", async (request, reply) => {
      try {
        const key = await authenticateKey(db, request.headers.authorization);
        // The scope check needs the artifact's repo and therefore waits for the body; the
        // permission check does not, and it is the one that keeps a read-only key from spending
        // this route's raised limit.
        requirePermission(key, "assert");
        authed.set(request, key);
        return;
      } catch (err) {
        await sendRejection(deps, request, reply, err, { actor: null });
        // Returning the reply is how an async hook says "the lifecycle stops here"; without it
        // Fastify goes on to read the body it was just refused.
        return reply;
      }
    });

    branch.post("/v1/graph/index", async (request, reply) => {
      const key = authed.get(request);
      let scope: string | undefined;
      try {
        if (key === undefined) {
          // Unreachable: the hook above either fills this or ends the request. Stated rather than
          // asserted away with `!` so that a future edit to the hook fails closed.
          throw new Rejection({
            reason: "unauthorized",
            message: "This route authenticates before reading the body; no key was recorded.",
            detail: {},
          });
        }
        const query = parse(IndexQuery, request.query);
        const artifact = parse(
          GraphArtifactSchema,
          await decodeArtifact(request.body, request.headers["content-encoding"]),
        );

        // Settled before the load, because it decides what the key is being authorised for: the
        // scope the index will carry, not the repo it names.
        scope = query.scope ?? indexScope(deps.config.orgScope, artifact.repo);
        requireScope(key, scope);

        // Re-posting a commit is not an update. `ingestGraph` refuses a second load of the same
        // (repo, commit_sha, indexer) with a 400 carrying the existing index id — indexes are
        // never mutated, so idempotency here means "the first load wins and says so", and this
        // route does not get to invent a second rule about it.
        const loaded = await ingestGraph(db, artifact, { scope });
        return reply.code(201).send({
          ok: true,
          index_id: loaded.indexId,
          repo: artifact.repo,
          commit_sha: artifact.commit_sha,
          symbol_count: loaded.symbols,
          edge_count: loaded.edges,
          // What retention dropped to make room. Reported rather than logged: an operator watching
          // a volume needs to see the bound working from the same response that filled it.
          pruned: loaded.pruned,
          ...(loaded.pruneError === undefined ? {} : { prune_error: loaded.pruneError }),
        });
      } catch (err) {
        return sendRejection(deps, request, reply, err, { actor: key?.label ?? null, scope });
      }
    });
  });
}
