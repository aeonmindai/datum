import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { mintKey } from "../http/auth.js";
import { assertFact } from "../domain/store.js";

/**
 * `datum init`, run automatically on boot and safe to run repeatedly.
 *
 * On a one-click platform the deploy logs are the only channel available for a one-time secret,
 * so the first key is printed there, once, with an unmissable marker. On every later boot this
 * function does nothing but confirm the org scope exists.
 */

export interface InitResult {
  orgScope: string;
  createdScope: boolean;
  firstKeySecret: string | null;
}

export async function initInstance(db: Db, config: Config): Promise<InitResult> {
  const scope = await db.query(
    "app",
    `INSERT INTO datum.scopes (path, kind, label, created_by)
     VALUES ($1, 'org', $2, 'datum init')
     ON CONFLICT (path) DO NOTHING`,
    [config.orgScope, config.org],
  );

  const existing = await db.one<{ n: string }>(
    "app",
    "SELECT count(*)::text AS n FROM datum.api_keys",
  );
  let firstKeySecret: string | null = null;
  if (Number(existing?.n ?? 0) === 0) {
    const minted = await mintKey(db, {
      label: "first-key",
      scope: config.orgScope,
      permissions: ["read", "assert", "supersede", "admin"],
      expiresAt: null,
      createdBy: "datum init",
    });
    firstKeySecret = minted.secret;
  }

  // §11: bearer API keys are a deliberate v0 shortcut against MCP's expectation of an OAuth 2.1
  // resource server. Recording it in the store is what stops it being quietly forgotten — and it
  // is the kind of thing the store exists to make un-forgettable.
  await assertFact(
    db,
    {
      scope: config.orgScope,
      subject: "datum:auth",
      predicate: "agent_auth_mechanism",
      object: { value: "bearer-api-key", unit: "mechanism" },
      claim:
        "agent access uses opaque bearer API keys, not OAuth 2.1 token exchange. Deliberate v0 " +
        "shortcut: MCP 2026-07-28 expects an OAuth 2.1 resource server. When this outgrows keys, " +
        "never issue refresh tokens to agents — one org grant plus RFC 8693 exchange for short, " +
        "single-audience, scope-bound tokens.",
      kind: "state",
      evidence: { source: "HANDOFF.md §11", instrument: "datum init" },
      asserted_by: "service:init",
      valid_from: "2026-08-24T00:00:00Z",
    },
    { role: "app" },
  ).catch((err: unknown) => {
    console.error(`[init] could not record the auth shortcut: ${(err as Error).message}`);
  });

  return {
    orgScope: config.orgScope,
    createdScope: (scope.rowCount ?? 0) > 0,
    firstKeySecret,
  };
}
