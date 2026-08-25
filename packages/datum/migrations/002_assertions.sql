-- 002 — the core object. Immutable, content-addressed, bitemporal.
--
-- Every CHECK here is named, and every name is a machine-readable rejection reason:
-- Postgres reports it in the error's `constraint` field, which the API maps straight to
-- `reason` in its 422 body. There is no second, softer path where a bad write is warned
-- about and kept.

CREATE TABLE IF NOT EXISTS datum.verifications (
  id                  text PRIMARY KEY,
  target_assertion_id text NOT NULL,
  outcome             text NOT NULL,
  checker             text NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT verification_outcome_known
    CHECK (outcome IN ('confirmed', 'refuted', 'unresolvable'))
);

CREATE TABLE IF NOT EXISTS datum.assertions (
  id              text        PRIMARY KEY,
  -- sha256 over the canonical body. The identity: re-asserting the identical claim with
  -- the identical evidence is the same datum, whoever says it, so `assert` is idempotent.
  hash            text        NOT NULL UNIQUE,

  scope           text        NOT NULL,
  scope_depth     int         GENERATED ALWAYS AS (array_length(string_to_array(scope, '/'), 1)) STORED,
  subject         text        NOT NULL,
  predicate       text        NOT NULL,
  object          jsonb       NOT NULL,
  claim           text,
  claim_fts       tsvector    GENERATED ALWAYS AS (
                                to_tsvector('english',
                                  coalesce(claim, '') || ' ' || subject || ' ' || predicate)
                              ) STORED,

  kind            text        NOT NULL,
  binding         boolean     NOT NULL DEFAULT false,
  confidence      text        NOT NULL,

  evidence        jsonb,

  -- valid-time: when the fact was true in the world.
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  valid_period    tstzrange   GENERATED ALWAYS AS (tstzrange(valid_from, valid_to, '[)')) STORED,

  -- assert-time: when we learned it. A sequence, not a clock.
  asserted_at     bigint      NOT NULL DEFAULT nextval('datum.assert_seq'),
  asserted_by     text        NOT NULL,

  supersedes      text        REFERENCES datum.assertions(id),
  -- DEFERRABLE because the supersession stamp is applied by a BEFORE INSERT trigger, so it
  -- necessarily names a row that does not exist yet. Deferring this FK to commit costs
  -- nothing: it is bookkeeping. Deferring the exclusion constraint instead would have been
  -- the wrong trade — that one must stay immediate, so a contradiction is un-insertable
  -- rather than merely un-committable.
  superseded_by   text        REFERENCES datum.assertions(id) DEFERRABLE INITIALLY DEFERRED,
  superseded_at   bigint,

  why             text,
  reopen_if       text,
  causality       text,
  derived_from    text[]      NOT NULL DEFAULT '{}',
  verification_id text        REFERENCES datum.verifications(id),

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- ---- shape -------------------------------------------------------------------------
  CONSTRAINT id_shape        CHECK (id   ~ '^a_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT hash_shape      CHECK (hash ~ '^sha256:[0-9a-f]{64}$'),
  -- No leading root label is privileged. `org/acme/...` and `tenant/x/org/acme/...` are
  -- both well-formed, which is what keeps multi-tenancy additive later (§15.1).
  CONSTRAINT scope_shape     CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT subject_present   CHECK (length(btrim(subject))   > 0),
  CONSTRAINT predicate_present CHECK (length(btrim(predicate)) > 0),
  CONSTRAINT kind_known      CHECK (kind IN
    ('measured','target','rule','constraint','state','untried','failed','dead')),
  CONSTRAINT confidence_known CHECK (confidence IN
    ('measured','confirmed-by-human','derived','unverified')),
  CONSTRAINT valid_period_ordered CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- ---- INVARIANT 1: no assertion without evidence ------------------------------------
  -- Optional provenance provably decays: Wikidata reached only ~68% referenced statements
  -- after a decade of it being optional. So it is not optional.
  CONSTRAINT evidence_required CHECK (
    evidence IS NOT NULL
    AND jsonb_typeof(evidence) = 'object'
    AND evidence ? 'source'
    AND length(btrim(evidence->>'source')) > 0
  ),
  -- `confirmed-by-human` means *a named human*, not "someone told me".
  CONSTRAINT human_evidence_names_a_human CHECK (
    confidence <> 'confirmed-by-human'
    OR (evidence ? 'human' AND length(btrim(evidence->>'human')) > 0)
  ),

  -- ---- a dead end must carry its own falsifier ---------------------------------------
  CONSTRAINT failure_requires_why CHECK (
    kind NOT IN ('failed','dead') OR (why IS NOT NULL AND length(btrim(why)) > 0)
  ),
  CONSTRAINT failed_requires_reopen_if CHECK (
    kind <> 'failed' OR (reopen_if IS NOT NULL AND length(btrim(reopen_if)) > 0)
  ),

  -- ---- INVARIANT 4: confidence is earned ---------------------------------------------
  -- The role gate lives in a trigger (only datum_verifier may write these classes); this
  -- pair is the paper trail that must exist even then.
  CONSTRAINT measured_requires_verification CHECK (
    confidence <> 'measured' OR verification_id IS NOT NULL
  ),
  CONSTRAINT derived_requires_inputs CHECK (
    confidence <> 'derived' OR coalesce(array_length(derived_from, 1), 0) >= 1
  ),

  -- ---- supersession bookkeeping ------------------------------------------------------
  CONSTRAINT no_self_supersede CHECK (supersedes IS NULL OR supersedes <> id),
  CONSTRAINT superseded_at_with_by CHECK ((superseded_by IS NULL) = (superseded_at IS NULL))
);

-- ---- INVARIANT 3: no two live contradicting assertions, within the machine tier -------
--
-- Two reproducible facts disagreeing about the same subject over the same period is a
-- data defect, so make it physically un-insertable and force an explicit supersession.
--
-- `confirmed-by-human` and `unverified` rows are EXEMPT BY DESIGN (§16, §17): they coexist
-- and raise a `contradiction` record instead. That is safe because a mission gate
-- evaluates only rows of the class it demands, so testimony can never satisfy a gate that
-- requires `measured` — the disagreement becomes visible without becoming load-bearing.
--
-- `scope` is part of the key, which is also why a project asserting its own value for the
-- same predicate as its org simply wins locally and raises nothing (§5).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'no_two_live_contradictions'
  ) THEN
    ALTER TABLE datum.assertions ADD CONSTRAINT no_two_live_contradictions
      EXCLUDE USING gist (
        scope        WITH =,
        subject      WITH =,
        predicate    WITH =,
        valid_period WITH &&
      ) WHERE (superseded_by IS NULL
               AND confidence IN ('measured', 'derived'));
  END IF;
END
$$;

-- ---- retrieval: exact-first, and supersession-aware -----------------------------------
-- Naive append-only scores *below no memory at all* under fact reversal (TEPA, p<0.001),
-- so hiding superseded rows is not an optimisation, it is the difference between this
-- working and being harmful. The partial indexes make the live set the cheap path.
CREATE INDEX IF NOT EXISTS assertions_live_exact
  ON datum.assertions (scope, subject, predicate, kind)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS assertions_live_scope_depth
  ON datum.assertions (scope, scope_depth DESC, asserted_at DESC)
  WHERE superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS assertions_asof
  ON datum.assertions (subject, predicate, asserted_at DESC);

CREATE INDEX IF NOT EXISTS assertions_claim_fts
  ON datum.assertions USING gin (claim_fts);

CREATE INDEX IF NOT EXISTS assertions_supersedes    ON datum.assertions (supersedes);
CREATE INDEX IF NOT EXISTS assertions_superseded_by ON datum.assertions (superseded_by);
CREATE INDEX IF NOT EXISTS assertions_pending_verification
  ON datum.assertions (asserted_at)
  WHERE confidence = 'unverified' AND superseded_by IS NULL;

CREATE INDEX IF NOT EXISTS verifications_target ON datum.verifications (target_assertion_id);

-- ---- INVARIANT 2: no mutation, ever --------------------------------------------------
-- Enforced twice, deliberately. First by the grant system, as specified: the runtime role
-- is never given UPDATE or DELETE, so the attempt dies at the privilege check (42501).
-- Second by a trigger (003), so the same write is refused with a machine-readable reason
-- even when it arrives as the table owner.
GRANT SELECT, INSERT ON datum.assertions   TO datum_app;
GRANT SELECT           ON datum.verifications TO datum_app;
GRANT SELECT, INSERT   ON datum.verifications TO datum_verifier;
REVOKE UPDATE, DELETE, TRUNCATE ON datum.assertions   FROM datum_app, datum_verifier;
REVOKE UPDATE, DELETE, TRUNCATE ON datum.verifications FROM datum_app, datum_verifier;
