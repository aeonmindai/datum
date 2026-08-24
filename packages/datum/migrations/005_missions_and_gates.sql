-- 005 — INVARIANT 5: no target without a machine-checkable gate.
--
-- Every production goal-check found in the research is either an LLM judgement
-- (OpenHands GoalVerdict) or a human-written shell hook. A gate here is a predicate the
-- database can evaluate, and — the part nobody else has — it names the evidence class it
-- will accept. That single field is what makes advisory contradictions safe: a
-- `confirmed-by-human` row cannot satisfy a gate demanding `measured`, however
-- confidently it is written, so allowing humans to contradict instruments can never make
-- a target look reached.

CREATE OR REPLACE FUNCTION datum.gate_is_machine_checkable(g jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT g IS NOT NULL
     AND jsonb_typeof(g) = 'object'
     AND coalesce(length(btrim(g->>'subject')),   0) > 0
     AND coalesce(length(btrim(g->>'predicate')), 0) > 0
     AND (g->>'op') IN ('>=','<=','>','<','=','!=')
     AND g ? 'target'
     -- An ordering comparison against a non-number is not machine-checkable.
     AND ((g->>'op') IN ('=','!=') OR jsonb_typeof(g->'target') = 'number')
     AND (g->>'requires_confidence') IN
           ('measured','confirmed-by-human','derived','unverified')
$$;

CREATE OR REPLACE FUNCTION datum.gates_are_machine_checkable(gates jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT gates IS NOT NULL
     AND jsonb_typeof(gates) = 'array'
     AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(gates) AS g
            WHERE NOT datum.gate_is_machine_checkable(g.value))
$$;

-- A `kind: target` assertion carries its own gate in `object`: subject and predicate come
-- from the assertion, so the object must supply the comparison and the evidence class.
CREATE OR REPLACE FUNCTION datum.target_object_is_machine_checkable(o jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT o IS NOT NULL
     AND jsonb_typeof(o) = 'object'
     AND (o->>'op') IN ('>=','<=','>','<','=','!=')
     AND o ? 'value'
     AND ((o->>'op') IN ('=','!=') OR jsonb_typeof(o->'value') = 'number')
     AND (o->>'requires_confidence') IN
           ('measured','confirmed-by-human','derived','unverified')
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'target_requires_machine_checkable_gate') THEN
    ALTER TABLE datum.assertions ADD CONSTRAINT target_requires_machine_checkable_gate
      CHECK (kind <> 'target' OR datum.target_object_is_machine_checkable(object));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS datum.missions (
  id            text PRIMARY KEY,
  scope         text NOT NULL,
  statement     text NOT NULL,
  state         text NOT NULL,
  gates         jsonb NOT NULL DEFAULT '[]'::jsonb,
  version       int  NOT NULL DEFAULT 1,
  supersedes    text REFERENCES datum.missions(id),
  superseded_by text REFERENCES datum.missions(id),
  asserted_at   bigint NOT NULL DEFAULT nextval('datum.assert_seq'),
  asserted_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mission_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT mission_state_known CHECK (state IN ('proposed','active','blocked','closed')),
  CONSTRAINT mission_statement_present CHECK (length(btrim(statement)) > 0),
  CONSTRAINT gates_must_be_machine_checkable
    CHECK (datum.gates_are_machine_checkable(gates)),
  -- The invariant, stated: an active objective with nothing checkable attached is exactly
  -- the "goal as vibe" this replaces.
  CONSTRAINT active_mission_requires_gate CHECK (
    state <> 'active'
    OR (jsonb_typeof(gates) = 'array' AND jsonb_array_length(gates) > 0)
  ),
  CONSTRAINT mission_no_self_supersede CHECK (supersedes IS NULL OR supersedes <> id)
);

CREATE INDEX IF NOT EXISTS missions_live ON datum.missions (scope, state)
  WHERE superseded_by IS NULL;

-- Missions are versioned by supersession too, so an edited objective never silently
-- erases the one it replaced.
CREATE OR REPLACE FUNCTION datum.fn_missions_no_mutate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
DECLARE
  v_exempt text[] := datum.immutability_exempt_columns('datum.missions'::regclass);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'missions are append-only: DELETE is never permitted (id=%)', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'missions_are_append_only',
            DETAIL = json_build_object('reason','missions_are_append_only','id',OLD.id)::text;
  END IF;
  IF (to_jsonb(OLD) - v_exempt) IS DISTINCT FROM (to_jsonb(NEW) - v_exempt) THEN
    RAISE EXCEPTION 'missions are immutable: supersede with a new version (id=%)', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'missions_are_immutable',
            DETAIL = json_build_object('reason','missions_are_immutable','id',OLD.id)::text;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_missions_no_mutate ON datum.missions;
CREATE TRIGGER trg_missions_no_mutate
  BEFORE UPDATE OR DELETE ON datum.missions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_missions_no_mutate();

CREATE OR REPLACE FUNCTION datum.fn_missions_apply_supersession()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = datum, pg_catalog AS $$
DECLARE v_target datum.missions;
BEGIN
  IF NEW.supersedes IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_target FROM datum.missions WHERE id = NEW.supersedes FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot supersede unknown mission %', NEW.supersedes
      USING ERRCODE = '23514', CONSTRAINT = 'mission_supersedes_target_not_found',
            DETAIL = json_build_object('reason','mission_supersedes_target_not_found',
                                       'supersedes',NEW.supersedes)::text;
  END IF;
  IF v_target.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'mission % is already superseded by %', v_target.id, v_target.superseded_by
      USING ERRCODE = '23514', CONSTRAINT = 'mission_supersedes_target_already_superseded',
            DETAIL = json_build_object('reason','mission_supersedes_target_already_superseded',
                                       'supersedes',v_target.id,
                                       'already_superseded_by',v_target.superseded_by)::text;
  END IF;
  UPDATE datum.missions SET superseded_by = NEW.id WHERE id = NEW.supersedes;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_missions_apply_supersession ON datum.missions;
CREATE TRIGGER trg_missions_apply_supersession
  BEFORE INSERT ON datum.missions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_missions_apply_supersession();

-- ---------------------------------------------------------------------------------------
-- Gate evaluation. `p_chain` is the resolved scope chain, nearest first, produced by the
-- caller because the global/isolated mode decides where the chain stops (§5).
--
-- Note the two filters that carry the whole safety argument: `confidence` must equal the
-- class the gate demands (not "at least"), and only observation-shaped rows
-- (`kind = 'measured'`) are eligible. `reached: null` means no qualifying evidence exists
-- at all, which is a different and more useful answer than `false`.
CREATE OR REPLACE FUNCTION datum.evaluate_gate(p_gate jsonb, p_chain text[])
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = datum, pg_catalog AS $$
DECLARE
  v_row     datum.assertions;
  v_actual  numeric;
  v_target  numeric;
  v_op      text := p_gate->>'op';
  v_reached boolean;
BEGIN
  SELECT a.* INTO v_row
    FROM datum.assertions a
    JOIN unnest(p_chain) WITH ORDINALITY AS c(scope, ord) ON c.scope = a.scope
   WHERE a.superseded_by IS NULL
     AND a.subject    = p_gate->>'subject'
     AND a.predicate  = p_gate->>'predicate'
     AND a.confidence = p_gate->>'requires_confidence'
     AND a.kind       = 'measured'
   ORDER BY c.ord ASC, a.asserted_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'reached', NULL, 'actual', NULL, 'evidence', NULL,
      'requires_confidence', p_gate->>'requires_confidence',
      'why_null', 'no live assertion of the required confidence class in scope');
  END IF;

  IF jsonb_typeof(v_row.object->'value') = 'number'
     AND jsonb_typeof(p_gate->'target') = 'number' THEN
    v_actual := (v_row.object->>'value')::numeric;
    v_target := (p_gate->>'target')::numeric;
    v_reached := CASE v_op
                   WHEN '>=' THEN v_actual >= v_target
                   WHEN '<=' THEN v_actual <= v_target
                   WHEN '>'  THEN v_actual >  v_target
                   WHEN '<'  THEN v_actual <  v_target
                   WHEN '='  THEN v_actual =  v_target
                   WHEN '!=' THEN v_actual <> v_target
                 END;
  ELSE
    v_reached := CASE v_op
                   WHEN '='  THEN (v_row.object->'value') =           (p_gate->'target')
                   WHEN '!=' THEN (v_row.object->'value') IS DISTINCT FROM (p_gate->'target')
                   ELSE NULL
                 END;
  END IF;

  RETURN jsonb_build_object(
    'reached',             v_reached,
    'actual',              v_row.object->'value',
    'unit',                v_row.object->>'unit',
    'evidence',            v_row.id,
    'resolved_scope',      v_row.scope,
    'requires_confidence', p_gate->>'requires_confidence',
    'confidence',          v_row.confidence);
END
$$;

GRANT SELECT, INSERT ON datum.missions TO datum_app;
REVOKE UPDATE, DELETE, TRUNCATE ON datum.missions FROM datum_app, datum_verifier;
