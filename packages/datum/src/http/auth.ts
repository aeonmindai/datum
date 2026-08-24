import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { newId, sha256Hex } from "../domain/identity.js";
import { Rejection } from "../domain/errors.js";
import { assertFact } from "../domain/store.js";
import { isDescendantOf } from "../domain/scope.js";

/**
 * Three separate concerns, deliberately not collapsed: the admin password, agent API keys, and
 * what replaces keys later.
 *
 * On the last one, the design is already decided and worth writing down here so it is not
 * re-litigated under pressure: **never issue refresh tokens to agents.** Arc lost a running job
 * twice to a single-use refresh token raced by concurrent agents, and that is the spec working
 * as designed — RFC 9700 §4.14.2 concedes the authorization server cannot tell which party
 * submitted the invalid token, so the correct response is revoking the whole family, which
 * kills the fleet. The successor is one org-level grant plus RFC 8693 token exchange for
 * short-lived, single-audience, scope-bound access tokens. Expiry replaces revocation, so
 * concurrency stops being an event.
 */

export const PERMISSIONS = ["read", "assert", "supersede", "admin"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const KEY_PREFIX = "dtm_live_";

export interface AuthedKey {
  id: string;
  label: string;
  scope: string;
  permissions: string[];
}

export interface MintedKey {
  id: string;
  prefix: string;
  secret: string;
}

/** argon2id for the human-chosen admin password; the defaults in @node-rs/argon2 are the
 *  OWASP-recommended argon2id parameters, and picking our own numbers here would be worse. */
export const hashPassword = (plaintext: string): Promise<string> => argon2Hash(plaintext);

export async function resolveAdminHash(config: Config): Promise<string> {
  if (config.adminCredential.source === "hash") return config.adminCredential.hash;
  // Plaintext accepted so a one-click deploy works, hashed here, and never persisted.
  const hashed = await hashPassword(config.adminCredential.plaintext);
  console.warn(
    "[auth] DATUM_ADMIN_PASSWORD was supplied in plaintext and hashed at boot. Switch to " +
      "DATUM_ADMIN_PASSWORD_HASH (run `datum hash-password`) and drop the plaintext variable.",
  );
  return hashed;
}

export async function checkPassword(hash: string, attempt: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, attempt);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Admin sessions: a signed cookie, no server-side session table.

export const SESSION_COOKIE = "datum_session";

export function signSession(config: Config, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ sub: "admin", exp: expiresAtMs })).toString(
    "base64url",
  );
  const mac = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifySession(config: Config, cookie: string | undefined): boolean {
  if (!cookie) return false;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = cookie.slice(0, dot);
  const mac = Buffer.from(cookie.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", config.sessionSecret).update(payload).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("exp" in parsed)) return false;
    const exp = parsed.exp;
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Agent API keys.

export async function mintKey(
  db: Db,
  input: {
    label: string;
    scope: string;
    permissions: string[];
    expiresAt: string | null;
    createdBy: string;
  },
): Promise<MintedKey> {
  const secret = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const id = newId("k");
  const prefix = secret.slice(0, KEY_PREFIX.length + 6);
  await db.query(
    "app",
    `INSERT INTO datum.api_keys (id, prefix, secret_hash, label, scope, permissions, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      prefix,
      sha256Hex(secret),
      input.label,
      input.scope,
      input.permissions,
      input.expiresAt,
      input.createdBy,
    ],
  );
  return { id, prefix, secret };
}

export async function authenticateKey(db: Db, header: string | undefined): Promise<AuthedKey> {
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!bearer) {
    throw new Rejection({
      reason: "unauthorized",
      message: "Present Authorization: Bearer dtm_live_… — mint a key in /admin.",
    });
  }
  const row = await db.one<{
    id: string;
    label: string;
    scope: string;
    permissions: string[];
    expired: boolean;
  }>(
    "app",
    `SELECT id, label, scope, permissions,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM datum.api_keys
      WHERE secret_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(bearer)],
  );
  if (!row) throw new Rejection({ reason: "unauthorized", message: "Unknown or revoked key." });
  if (row.expired) throw new Rejection({ reason: "unauthorized", message: "This key has expired." });

  // Fire-and-forget: usage tracking must never add latency to a read on the p99 path, and a
  // key that stopped being used is usually an agent that died, which the panel surfaces.
  void db
    .query(
      "app",
      `UPDATE datum.api_keys SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`,
      [row.id],
    )
    .catch(() => {});

  return { id: row.id, label: row.label, scope: row.scope, permissions: row.permissions };
}

export function requirePermission(key: AuthedKey, permission: Permission): void {
  if (!key.permissions.includes(permission) && !key.permissions.includes("admin")) {
    throw new Rejection({
      reason: "forbidden",
      message: `This key holds [${key.permissions.join(", ")}] and needs "${permission}".`,
      detail: { held: key.permissions, needed: permission },
    });
  }
}

/** A key is bound to a scope subtree. Scope-bound tokens are one of the three published
 *  mitigations for memory injection, which achieves >95% success with query-only access. */
export function requireScope(key: AuthedKey, scope: string): void {
  if (!isDescendantOf(scope, key.scope)) {
    throw new Rejection({
      reason: "forbidden",
      message: `This key is bound to ${key.scope} and cannot reach ${scope}.`,
      detail: { key_scope: key.scope, requested: scope },
    });
  }
}

// ---------------------------------------------------------------------------------------
// Login attempts: recorded in the store, because the panel dogfoods the product.

const LOGIN_SUBJECT = "admin:login";
const LOGIN_PREDICATE = "failed_login";

export async function recordFailedLogin(db: Db, config: Config, ip: string): Promise<void> {
  await assertFact(
    db,
    {
      scope: config.orgScope,
      subject: LOGIN_SUBJECT,
      predicate: LOGIN_PREDICATE,
      object: { value: ip, unit: "client ip" },
      claim: `failed admin login from ${ip}`,
      kind: "state",
      evidence: { source: "POST /admin/api/login", instrument: "datum admin panel" },
      asserted_by: "service:admin",
      valid_from: new Date().toISOString(),
    },
    { role: "app" },
  ).catch((err: unknown) => {
    console.error(`[auth] could not record failed login: ${(err as Error).message}`);
  });
}

export async function loginAttemptsRemaining(
  db: Db,
  config: Config,
  ip: string,
): Promise<{ remaining: number; retryAfterSeconds: number }> {
  const row = await db.one<{ n: string; oldest: string | null }>(
    "app",
    `SELECT count(*)::text AS n, min(valid_from)::text AS oldest
       FROM datum.assertions
      WHERE scope = $1 AND subject = $2 AND predicate = $3
        AND object->>'value' = $4
        AND valid_from > now() - ($5::int * interval '1 second')`,
    [config.orgScope, LOGIN_SUBJECT, LOGIN_PREDICATE, ip, config.loginRateLimit.windowSeconds],
  );
  const used = Number(row?.n ?? 0);
  const remaining = Math.max(0, config.loginRateLimit.attempts - used);
  let retryAfterSeconds = 0;
  if (remaining === 0 && row?.oldest) {
    const oldest = new Date(row.oldest).getTime();
    retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + config.loginRateLimit.windowSeconds * 1000 - Date.now()) / 1000),
    );
  }
  return { remaining, retryAfterSeconds };
}
