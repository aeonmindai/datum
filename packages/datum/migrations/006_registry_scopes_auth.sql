-- 006 — scopes, the registry, API keys.
--
-- KQML shipped a facilitator over a service registry in 1994 and no modern agent stack
-- has one. NANDA shows the shape holds at 13,600 agents with real liveness over months.
-- This is what makes 141 worktrees legible instead of frightening.
--
-- These are operational tables, not beliefs: `last_used_at` and `revoked_at` are ordinary
-- mutable state and are deliberately not held to invariant 2. Only assertions and
-- missions are append-only, because only they are the record.

CREATE TABLE IF NOT EXISTS datum.scopes (
  path       text PRIMARY KEY,
  kind       text NOT NULL DEFAULT 'custom',
  label      text,
  depth      int GENERATED ALWAYS AS (array_length(string_to_array(path, '/'), 1)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT scope_path_shape CHECK (path ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT scope_kind_known CHECK (kind IN ('org','proj','mission','agent','custom'))
);

CREATE TABLE IF NOT EXISTS datum.nodes (
  id           text PRIMARY KEY,
  kind         text NOT NULL,
  scope        text NOT NULL,
  label        text NOT NULL,
  role         text,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_at timestamptz,
  last_seen    timestamptz,
  retired_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT node_kind_known
    CHECK (kind IN ('agent','worktree','branch','repo','webhook','human','service')),
  CONSTRAINT node_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$')
);
CREATE INDEX IF NOT EXISTS nodes_by_scope ON datum.nodes (scope, kind) WHERE retired_at IS NULL;

-- A node's identity is what it *is*, not a random id: one repo, one worktree path, one branch
-- name per scope. Without this, re-running `datum link` in 141 worktrees would produce 282 rows
-- and the registry would be less legible than the thing it replaced.
CREATE UNIQUE INDEX IF NOT EXISTS nodes_identity
  ON datum.nodes (kind, scope, label) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS nodes_live ON datum.nodes (last_seen DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS datum.api_keys (
  id           text PRIMARY KEY,
  -- Shown in the UI so a key is identifiable without being recoverable.
  prefix       text NOT NULL,
  -- sha256 of the full secret. The secret is 32 bytes of CSPRNG output, so a slow KDF
  -- buys nothing here; argon2id is reserved for the human-chosen admin password.
  secret_hash  text NOT NULL UNIQUE,
  label        text NOT NULL,
  scope        text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{read}',
  expires_at   timestamptz,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count    bigint NOT NULL DEFAULT 0,
  revoked_at   timestamptz,
  CONSTRAINT api_key_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT api_key_permissions_known CHECK (
    permissions <@ ARRAY['read','assert','supersede','admin']::text[]
    AND array_length(permissions, 1) >= 1)
);
CREATE INDEX IF NOT EXISTS api_keys_live ON datum.api_keys (created_at DESC)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT         ON datum.scopes   TO datum_app;
GRANT SELECT, INSERT, UPDATE ON datum.nodes    TO datum_app;
GRANT SELECT, INSERT, UPDATE ON datum.api_keys TO datum_app;
