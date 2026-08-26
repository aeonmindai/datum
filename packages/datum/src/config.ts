/**
 * Configuration. Nothing about any one organisation is hardcoded anywhere in this file or
 * downstream of it: `DATUM_ORG=acme` yields the scope root `org/acme`, and no query assumes
 * the configured root is the top of the tree. That single discipline is what makes a tenant
 * dimension additive later instead of a rewrite of the one table we promised never to mutate.
 *
 * The server fails closed. A shipped default password is a CVE, not a convenience.
 */

export type AdminCredential =
  | { readonly source: "hash"; readonly hash: string }
  | { readonly source: "plaintext"; readonly plaintext: string };

export interface Config {
  readonly org: string;
  readonly orgScope: string;
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  readonly publicUrl: string;
  readonly adminCredential: AdminCredential;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly loginRateLimit: { readonly attempts: number; readonly windowSeconds: number };
  /** Bare or working git clones the verification worker may consult, keyed by "owner/repo". */
  readonly gitMirrors: Readonly<Record<string, string>>;
  /** Optional GitHub token, used only when no local mirror answers for a repo. */
  readonly githubToken: string | null;
  readonly verifyIntervalMs: number;
  readonly verifyBatchSize: number;
  readonly adminDistDir: string | null;
  /**
   * Directories searched by the prose fallback. Nothing read from here is ever written to the
   * store — it is retrieved live and returned under a separate `from_prose` key — so these are
   * read paths, not a source of record.
   */
  readonly proseRoots: readonly string[];
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const FAIL_CLOSED = `
Datum refuses to boot without an admin credential and a session secret.
There is no default password in this image, by design.

  # generate a session secret
  export DATUM_SESSION_SECRET="$(openssl rand -hex 32)"

  # then either hash a password yourself (preferred)
  npx @aeonmind/datum hash-password 'your-password'
  export DATUM_ADMIN_PASSWORD_HASH='<the $argon2id$... string it prints>'

  # ...or hand over the plaintext and let the server hash it at boot
  export DATUM_ADMIN_PASSWORD='your-password'
`.trim();

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    throw new ConfigError(
      `${key} is required.\n\nSet it and start again. For DATABASE_URL, docker compose supplies it; ` +
        `on Fly it comes from 'fly secrets set DATABASE_URL=...'.`,
    );
  }
  return v.trim();
}

function parseGitMirrors(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || raw.trim() === "") return out;
  // "owner/repo=/path/to/clone,other/repo=/path" — deliberately not JSON, because this gets
  // typed into a shell by hand more often than it gets generated.
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const repo = pair.slice(0, eq).trim();
    const path = pair.slice(eq + 1).trim();
    if (repo && path) out[repo] = path;
  }
  return out;
}

/**
 * `serving: false` is for commands that only ever touch the database — migrate, index,
 * ingest-graph, ingest-sessions, seed, verify, recall, resume, fleet.
 *
 * Fail-closed exists so no default credential ships in the image and nothing can be reached
 * anonymously over HTTP. Applying it to a migration buys none of that: whoever holds
 * DATABASE_URL already has every row. What it does buy is an operator inventing a throwaway
 * admin password in order to run `migrate`, which is friction with a security theatre smell,
 * and it is the first thing anyone hits when wiring a real repository up. Found by writing the
 * onboarding script and having step 1 of 4 fail on a fresh database.
 *
 * The rule that must not move: anything that SERVES still refuses to boot without a credential
 * and a session secret.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { serving?: boolean } = {},
): Config {
  const serving = opts.serving ?? true;
  const org = (env.DATUM_ORG ?? "local").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(org)) {
    throw new ConfigError(
      `DATUM_ORG must be a single scope label matching [A-Za-z0-9_.-]+ (got ${JSON.stringify(org)}).`,
    );
  }

  const hash = env.DATUM_ADMIN_PASSWORD_HASH?.trim();
  const plaintext = env.DATUM_ADMIN_PASSWORD?.trim();
  let adminCredential: AdminCredential;
  if (hash) {
    adminCredential = { source: "hash", hash };
  } else if (plaintext) {
    // §15.2: one-click platforms cannot run a hashing command before boot, and a button
    // that immediately crashes is worse than no button. So plaintext is accepted, hashed at
    // boot, and never persisted — the invariant that survives is "no default credential
    // ships in the image", which is the one that actually matters.
    adminCredential = { source: "plaintext", plaintext };
  } else if (serving) {
    throw new ConfigError(FAIL_CLOSED);
  } else {
    // Unreachable as a credential: nothing consults it on a non-serving path, and any attempt to
    // verify a password against it fails. It exists so the type stays honest.
    adminCredential = { source: "hash", hash: "" };
  }

  const sessionSecret = env.DATUM_SESSION_SECRET?.trim();
  if (!sessionSecret && serving) throw new ConfigError(FAIL_CLOSED);
  if (sessionSecret && sessionSecret.length < 32) {
    throw new ConfigError(
      "DATUM_SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -hex 32",
    );
  }

  // 0 is allowed and means "any free port", which is the normal idiom for a throwaway instance.
  const port = Number.parseInt(env.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be a valid TCP port (got ${JSON.stringify(env.PORT)}).`);
  }

  return {
    org,
    orgScope: `org/${org}`,
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    port,
    host: env.HOST ?? "0.0.0.0",
    publicUrl: (env.DATUM_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    adminCredential,
    // Empty only on a non-serving path, where nothing signs or verifies a cookie. `serving: true`
    // has already refused to get here without one.
    sessionSecret: sessionSecret ?? "",
    sessionTtlSeconds: Number.parseInt(env.DATUM_SESSION_TTL_SECONDS ?? "43200", 10),
    loginRateLimit: {
      attempts: Number.parseInt(env.DATUM_LOGIN_ATTEMPTS ?? "5", 10),
      windowSeconds: Number.parseInt(env.DATUM_LOGIN_WINDOW_SECONDS ?? "900", 10),
    },
    gitMirrors: parseGitMirrors(env.DATUM_GIT_MIRRORS),
    githubToken: env.DATUM_GITHUB_TOKEN?.trim() || null,
    verifyIntervalMs: Number.parseInt(env.DATUM_VERIFY_INTERVAL_MS ?? "15000", 10),
    verifyBatchSize: Number.parseInt(env.DATUM_VERIFY_BATCH_SIZE ?? "25", 10),
    adminDistDir: env.DATUM_ADMIN_DIST?.trim() || null,
    // Colon- or comma-separated, so it survives both a shell PATH habit and a .env file.
    proseRoots: (env.DATUM_PROSE_ROOTS ?? "")
      .split(/[:,]/)
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
  };
}

/** No telemetry, no license check, no phone-home. An org running a truth store will read
 *  the network calls; there must be none to find. The only outbound host Datum ever
 *  contacts is the GitHub API, and only if you configure a token for verification. */
export const OUTBOUND_HOSTS_BY_DESIGN = ["api.github.com (verification only, opt-in)"] as const;
