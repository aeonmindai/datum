-- 013 - the fleet: what is everyone doing right now.
--
-- `datum.nodes` has existed since 006 and holds identity - this agent, that worktree, this
-- branch - with a heartbeat. What it cannot answer is the question that actually gets asked on a
-- machine carrying 141 working copies and 426 branches: *what is that one doing, and is it about
-- to edit the file I am editing?*
--
-- KQML shipped a facilitator over a service registry in 1994 and no modern agent stack has one.
-- NANDA shows the shape holds at 13,600 agents with real liveness over months. Two tables here,
-- both boring on purpose:
--
--   activity - a heartbeat that carries a sentence. Append-only, so "what was it doing an hour
--              ago" is answerable, and the current answer is the newest row.
--   claims   - a node saying "I am touching these paths". Advisory, deliberately: a lock would
--              deadlock a fleet that dies unpredictably, and the useful signal is not "you may
--              not" but "you are the second agent in this file, here is the first".
--
-- Advisory rather than exclusive is the same call the contradiction design made. Blocking writes
-- between authority tiers would have been easy and wrong; blocking two agents from one file would
-- be easy and wrong for the same reason - the system does not know which of them is right.

CREATE TABLE IF NOT EXISTS datum.node_activity (
  id           text PRIMARY KEY,
  node_id      text NOT NULL REFERENCES datum.nodes(id),
  scope        text NOT NULL,
  statement    text NOT NULL,
  -- Optional link to the mission this work serves, so a fleet view can group by intent rather
  -- than by process.
  mission_id   text REFERENCES datum.missions(id),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  seq          bigint NOT NULL DEFAULT nextval('datum.assert_seq'),

  CONSTRAINT activity_id_shape CHECK (id ~ '^na_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT activity_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT activity_statement_present CHECK (length(btrim(statement)) > 0)
);

CREATE INDEX IF NOT EXISTS node_activity_node_time ON datum.node_activity (node_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS node_activity_scope_time ON datum.node_activity (scope, occurred_at DESC);

CREATE OR REPLACE FUNCTION datum.fn_activity_no_mutate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'node_activity is append-only; % refused', TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'activity_is_immutable',
          DETAIL = json_build_object('reason','activity_is_immutable')::text;
END
$$;

DROP TRIGGER IF EXISTS trg_activity_no_mutate ON datum.node_activity;
CREATE TRIGGER trg_activity_no_mutate
  BEFORE UPDATE OR DELETE ON datum.node_activity
  FOR EACH ROW EXECUTE FUNCTION datum.fn_activity_no_mutate();

-- ---------------------------------------------------------------------------------------------
-- Claims. `released_at` is the one mutable field in the fleet layer, and it is mutable because a
-- claim is a lease on attention rather than a fact about the world. Nothing is ever deleted.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS datum.node_claims (
  id           text PRIMARY KEY,
  node_id      text NOT NULL REFERENCES datum.nodes(id),
  scope        text NOT NULL,
  path         text NOT NULL,
  intent       text,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,

  CONSTRAINT claim_id_shape CHECK (id ~ '^nc_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT claim_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT claim_path_present CHECK (length(btrim(path)) > 0),
  CONSTRAINT claim_released_after_claimed CHECK (released_at IS NULL OR released_at >= claimed_at)
);

-- One live claim per (node, path): re-claiming is idempotent, not a second row.
CREATE UNIQUE INDEX IF NOT EXISTS node_claims_live
  ON datum.node_claims (node_id, path) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS node_claims_path ON datum.node_claims (path) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Who is live, and on what.
--
-- Liveness is a question about the last heartbeat, and the threshold is the caller's to choose -
-- a five-second agent and a nightly job have different ideas of "recent". Defaulting it to a
-- constant inside the query would bake one caller's assumption into everybody's answer.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION datum.fleet(p_scopes text[], p_stale_seconds int DEFAULT 300)
RETURNS TABLE (
  node_id     text,
  kind        text,
  label       text,
  scope       text,
  role        text,
  live        boolean,
  seconds_ago numeric,
  activity    text,
  activity_at timestamptz,
  claims      text[]
) LANGUAGE sql STABLE AS $$
  SELECT n.id, n.kind, n.label, n.scope, n.role,
         (now() - coalesce(n.heartbeat_at, n.last_seen)) < make_interval(secs => p_stale_seconds),
         round(extract(epoch FROM now() - coalesce(n.heartbeat_at, n.last_seen))::numeric, 1),
         a.statement, a.occurred_at,
         coalesce(c.paths, ARRAY[]::text[])
    FROM datum.nodes n
    LEFT JOIN LATERAL (
      SELECT statement, occurred_at FROM datum.node_activity
       WHERE node_id = n.id ORDER BY seq DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(path ORDER BY claimed_at) AS paths
        FROM datum.node_claims WHERE node_id = n.id AND released_at IS NULL
    ) c ON true
   WHERE n.retired_at IS NULL
     AND n.scope = ANY(p_scopes)
   ORDER BY coalesce(n.heartbeat_at, n.last_seen) DESC
$$;

-- Who else is in this file. Returns the *other* claimants, so a caller asking about its own claim
-- gets an empty answer rather than itself.
CREATE OR REPLACE FUNCTION datum.collisions(p_node_id text, p_paths text[])
RETURNS TABLE (path text, node_id text, label text, kind text, intent text, claimed_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT c.path, c.node_id, n.label, n.kind, c.intent, c.claimed_at
    FROM datum.node_claims c
    JOIN datum.nodes n ON n.id = c.node_id
   WHERE c.released_at IS NULL
     AND c.path = ANY(p_paths)
     AND c.node_id <> p_node_id
     AND n.retired_at IS NULL
   ORDER BY c.claimed_at
$$;

GRANT SELECT, INSERT ON datum.node_activity TO datum_app;
GRANT SELECT, INSERT ON datum.node_claims TO datum_app;
-- released_at only: a claim can be handed back, never rewritten.
GRANT UPDATE (released_at) ON datum.node_claims TO datum_app;
REVOKE UPDATE, DELETE, TRUNCATE ON datum.node_activity FROM datum_app, datum_verifier;
GRANT USAGE, SELECT ON SEQUENCE datum.assert_seq TO datum_app;
