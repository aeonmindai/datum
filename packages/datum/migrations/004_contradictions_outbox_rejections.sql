-- 004 — contradictions (advisory across authority tiers), the outbox, the rejection log.
--
-- No shipped system emits a contradiction object that requires resolution: every one of
-- them auto-resolves silently, by recency (Graphiti) or by posterior (TEPA). The best
-- multi-hop conflict score anywhere is 7.0% (MemoryAgentBench FactConsolidation at 262K).
-- So this table is the product, not a diagnostic.

CREATE TABLE IF NOT EXISTS datum.contradictions (
  id            text PRIMARY KEY,
  scope         text NOT NULL,
  subject       text NOT NULL,
  predicate     text NOT NULL,
  -- pair_key is order-independent, so the same disagreement can only be raised once
  -- however many times either side is re-read or re-asserted.
  pair_key      text NOT NULL UNIQUE,
  a_id          text NOT NULL REFERENCES datum.assertions(id),
  b_id          text NOT NULL REFERENCES datum.assertions(id),
  a_confidence  text NOT NULL,
  b_confidence  text NOT NULL,
  status        text NOT NULL DEFAULT 'open',
  -- The three honest exits (§17): recover the ref and promote, re-measure and supersede,
  -- or keep it labelled as an unreproducible historical observation.
  resolution    text,
  resolved_by   text,
  resolved_at   timestamptz,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contradiction_status_known
    CHECK (status IN ('open','resolved','superseded','unreproducible')),
  CONSTRAINT resolved_needs_resolution
    CHECK (status = 'open' OR resolution IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS contradictions_open
  ON datum.contradictions (detected_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS contradictions_a ON datum.contradictions (a_id);
CREATE INDEX IF NOT EXISTS contradictions_b ON datum.contradictions (b_id);

-- Fanout is an outbox table, written in v0 and not yet consumed. Never LISTEN/NOTIFY:
-- NOTIFY takes a global AccessExclusiveLock at commit, which serialises the entire
-- instance. NATS JetStream replaces this when projections land.
CREATE TABLE IF NOT EXISTS datum.outbox (
  seq        bigserial PRIMARY KEY,
  topic      text NOT NULL,
  payload    jsonb NOT NULL,
  -- GitLab's X-Gitlab-Event-UUID, verbatim in concept: one id, fresh for an externally
  -- caused event, inherited by everything that event causes. Loop detection, causal
  -- chains and blast-radius attribution from one field.
  causality  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unconsumed ON datum.outbox (seq) WHERE consumed_at IS NULL;

-- What the store refused, and why. The admin panel's most persuasive screen for a sceptic,
-- because it shows the invariants biting in real time. Written by the API after the
-- rejecting transaction has already rolled back, so it is necessarily a separate write.
CREATE TABLE IF NOT EXISTS datum.rejections (
  id         text PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text,
  route      text NOT NULL,
  reason     text NOT NULL,
  sqlstate   text,
  message    text,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope      text,
  subject    text,
  predicate  text
);
CREATE INDEX IF NOT EXISTS rejections_recent ON datum.rejections (at DESC);
CREATE INDEX IF NOT EXISTS rejections_reason ON datum.rejections (reason, at DESC);

-- ---------------------------------------------------------------------------------------
-- Detection. Fires on every insert; the exclusion constraint has already made the
-- machine-tier case impossible, so in practice this catches exactly the cross-tier
-- disagreements the constraint deliberately allows through.
CREATE OR REPLACE FUNCTION datum.fn_detect_contradictions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = datum, pg_catalog AS $$
BEGIN
  IF NEW.superseded_by IS NOT NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO datum.contradictions
    (id, scope, subject, predicate, pair_key, a_id, b_id, a_confidence, b_confidence)
  SELECT
    'c_' || datum.ulid_like(),
    NEW.scope, NEW.subject, NEW.predicate,
    least(a.id, NEW.id) || '|' || greatest(a.id, NEW.id),
    least(a.id, NEW.id), greatest(a.id, NEW.id),
    CASE WHEN a.id < NEW.id THEN a.confidence ELSE NEW.confidence END,
    CASE WHEN a.id < NEW.id THEN NEW.confidence ELSE a.confidence END
    FROM datum.assertions a
   WHERE a.id            <> NEW.id
     AND a.superseded_by IS NULL
     AND a.scope          = NEW.scope
     AND a.subject        = NEW.subject
     AND a.predicate      = NEW.predicate
     AND a.valid_period  && NEW.valid_period
     -- Agreeing about the same thing is not a contradiction.
     AND a.object IS DISTINCT FROM NEW.object
  ON CONFLICT (pair_key) DO NOTHING;

  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_assertions_detect_contradictions ON datum.assertions;
CREATE TRIGGER trg_assertions_detect_contradictions
  AFTER INSERT ON datum.assertions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_detect_contradictions();

-- Superseding one side of a disagreement resolves it. Recording that automatically is what
-- keeps the queue honest: a queue that never drains is a queue nobody reads.
CREATE OR REPLACE FUNCTION datum.fn_close_contradictions_on_supersede()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = datum, pg_catalog AS $$
BEGIN
  UPDATE datum.contradictions
     SET status = 'superseded',
         resolution = 'one side was superseded by ' || NEW.superseded_by,
         resolved_by = 'system:supersession',
         resolved_at = now()
   WHERE status = 'open'
     AND (a_id = NEW.id OR b_id = NEW.id);
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_close_contradictions_on_supersede ON datum.assertions;
CREATE TRIGGER trg_close_contradictions_on_supersede
  AFTER UPDATE OF superseded_by ON datum.assertions
  FOR EACH ROW WHEN (NEW.superseded_by IS NOT NULL)
  EXECUTE FUNCTION datum.fn_close_contradictions_on_supersede();

-- A Crockford-base32 ULID-shaped id generated in SQL, for rows the database raises on its
-- own (contradictions detected inside a trigger). Application-side writes use the real
-- monotonic ULID from the server.
CREATE OR REPLACE FUNCTION datum.ulid_like()
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = datum, pg_catalog AS $$
DECLARE
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_ms       bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_out      text := '';
  i          int;
BEGIN
  FOR i IN 1..10 LOOP
    v_out := substr(v_alphabet, (v_ms % 32)::int + 1, 1) || v_out;
    v_ms := v_ms / 32;
  END LOOP;
  FOR i IN 1..16 LOOP
    v_out := v_out || substr(v_alphabet, (floor(random() * 32))::int + 1, 1);
  END LOOP;
  RETURN v_out;
END
$$;

GRANT SELECT ON datum.contradictions TO datum_app;
-- Column-level on purpose. The disagreement itself is derived from the assertions and is not
-- editable: which two rows conflict, in what scope, over what predicate, is a fact. Only the
-- human resolution is mutable state, so only those four columns are grantable.
GRANT UPDATE (status, resolution, resolved_by, resolved_at) ON datum.contradictions TO datum_app;
GRANT SELECT, INSERT ON datum.rejections TO datum_app;
GRANT SELECT, INSERT ON datum.outbox TO datum_app;
GRANT USAGE, SELECT ON SEQUENCE datum.outbox_seq_seq TO datum_app;
