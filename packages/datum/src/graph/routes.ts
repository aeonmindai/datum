import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { authenticateKey, requirePermission, requireScope } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { impact, resolveIndex, searchSymbols } from "./store.js";
import { EDGE_KINDS, type EdgeKind } from "./types.js";

/**
 * The read surface for the code graph.
 *
 * Both routes are GET and both are read-only, so `sendRejection` is reused rather than reinvented:
 * it is the one place a refusal turns into a body, and it already knows not to write a rejection
 * row for a GET.
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

      const result = await impact(db, {
        repo: query.repo,
        symbol: query.symbol,
        commitSha: query.commit,
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
        commitSha: query.commit,
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
}
