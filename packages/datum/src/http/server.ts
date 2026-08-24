import { existsSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { startVerificationWorker, type WorkerHandle } from "../worker/verify.js";
import { initInstance } from "../ops/init.js";
import { registerAdmin } from "./admin.js";
import { registerMcp } from "./mcp.js";
import { registerV1 } from "./v1.js";
import { resolveAdminHash } from "./auth.js";

/**
 * One Fly app, one domain, everything under it:
 *
 *   /mcp        the facade, streamable HTTP POST
 *   /v1/*       the real interface
 *   /admin      the panel
 *   /healthz    liveness, unauthenticated
 *   /.well-known/oauth-protected-resource
 */

const DEFAULT_ADMIN_DIST = fileURLToPath(new URL("../../public/admin", import.meta.url));

export interface Server {
  app: FastifyInstance;
  db: Db;
  worker: WorkerHandle | null;
  close(): Promise<void>;
}

export async function buildServer(
  config: Config,
  opts: { runMigrations?: boolean; startWorker?: boolean; log?: boolean } = {},
): Promise<Server> {
  const db = new Db(config.databaseUrl);

  // Migrate on boot, idempotently, because one-click platforms have no reliable pre-deploy
  // hook and a README that tells a stranger to apply SQL files in order is how self-hosted
  // installs end up on undocumented schema drift.
  if (opts.runMigrations !== false) await migrate(db);
  const bootstrap = opts.runMigrations !== false ? await initInstance(db, config) : null;

  const app = Fastify({
    logger: opts.log === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(cookie);

  const adminHash = await resolveAdminHash(config);
  // What this instance can actually verify, stated accurately.
  //
  // The earlier version reported "not configured" whenever there was no mirror and no token,
  // and that was simply false: the GitHub API answers for PUBLIC repositories without any
  // credential, so rows were being promoted while the panel and the startup log both claimed
  // nothing could be. A store whose whole purpose is refusing unsupported claims does not get
  // to make one about itself.
  const mirrorCount = Object.keys(config.gitMirrors).length;
  const verification = {
    configured: true,
    method: (mirrorCount > 0 ? "local-mirror" : "github-api") as "local-mirror" | "github-api",
    authenticated: config.githubToken !== null,
    note:
      mirrorCount > 0
        ? `resolving commits from ${mirrorCount} local clone(s); no network involved`
        : config.githubToken
          ? "resolving commits via the GitHub API with a token, so private repos work too"
          : "resolving commits via the public GitHub API. Private repos cannot be read, and a claim about one is reported unresolvable rather than refuted — set DATUM_GITHUB_TOKEN to promote those.",
  };

  app.get("/healthz", async (_request, reply) => {
    try {
      await db.query("app", "SELECT 1");
      // `datum link` reads scope_root from here, unauthenticated, so a fresh clone can derive
      // its project scope without already holding a key.
      return reply.send({ ok: true, org: config.org, scope_root: config.orgScope });
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  registerV1(app, { db, config });
  registerMcp(app, { db, config });
  registerAdmin(app, { db, config, adminHash, verification });

  const adminDist = config.adminDistDir ?? DEFAULT_ADMIN_DIST;
  if (existsSync(adminDist)) {
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: "/admin/",
      wildcard: false,
      // Vite emits content-hashed asset filenames, so those are immutable forever and cheap to
      // cache hard. index.html is the opposite: it names this build's assets, so a cached copy
      // after a deploy points at files that no longer exist and the panel silently white-screens.
      setHeaders(res, path) {
        if (path.includes(`${sep}assets${sep}`)) {
          res.header("cache-control", "public, max-age=31536000, immutable");
        } else {
          res.header("cache-control", "no-store");
        }
      },
    });
    // The panel is hash-routed, so one index.html serves every deep link.
    app.get("/admin", async (_request, reply) => reply.redirect("/admin/", 302));
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && request.url.startsWith("/admin")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ ok: false, reason: "not_found", message: "No such route." });
    });
  } else {
    app.get("/admin", async (_request, reply) =>
      reply.code(503).type("text/plain").send(
        "The admin panel bundle is not present in this build.\n" +
          `Expected it at ${adminDist}.\n` +
          "Build it with: npm run build --workspace @aeonmind/datum-admin\n",
      ),
    );
  }

  const worker = opts.startWorker === false ? null : startVerificationWorker(db, config);
  if (worker) console.log(`[verify] ${verification.note}`);
  if (bootstrap?.firstKeySecret) {
    console.log(
      [
        "",
        "  ┌───────────────────────────────────────────────────────────────────────────┐",
        "  │  COPY THIS NOW — it is shown once and is not recoverable.                 │",
        "  └───────────────────────────────────────────────────────────────────────────┘",
        `  first API key: ${bootstrap.firstKeySecret}`,
        `  scope:         ${config.orgScope}`,
        "",
      ].join("\n"),
    );
  }

  return {
    app,
    db,
    worker,
    async close(): Promise<void> {
      worker?.stop();
      await app.close();
      await db.close();
    },
  };
}

export async function serve(config: Config): Promise<Server> {
  const server = await buildServer(config);
  await server.app.listen({ port: config.port, host: config.host });
  return server;
}
