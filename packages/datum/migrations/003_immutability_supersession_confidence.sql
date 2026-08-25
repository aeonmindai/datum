-- 003 — invariant 2 (no mutation), supersession, invariant 4 (confidence is earned).
--
-- Every rejection raises with an explicit CONSTRAINT name and a JSON DETAIL, so a trigger
-- refusal is indistinguishable from a CHECK refusal at the client: both arrive as
-- SQLSTATE 23514 with `constraint` set to the reason code.

-- ---------------------------------------------------------------------------------------
-- INVARIANT 2 — no mutation, ever.
--
-- The single permitted write to an existing row is the one-way supersession stamp, and
-- even that is not issued by the application: it comes from the SECURITY DEFINER trigger
-- below. Whitelisting by jsonb difference rather than by column list means a column added
-- in a later migration is protected the day it is added, with nothing to remember.
--
-- Append-only is also why concurrent writes are cheap rather than merely safe — Decker et
-- al. (IJCAI-91) measured 4.8x on 5 processors precisely because hypotheses are never
-- deleted, so only one lock is ever held and deadlock is impossible.
--
-- Generated columns are exempt from the comparison, and must be: Postgres computes them
-- *after* BEFORE triggers run, so in NEW they are still null and every UPDATE would look
-- like a rewrite. They are derived from the base columns anyway, so protecting the base
-- protects them. The exempt list is read from the catalogue rather than hardcoded, so a
-- column added by a later migration is covered the day it is added.
CREATE OR REPLACE FUNCTION datum.immutability_exempt_columns(p_table regclass)
RETURNS text[] LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  SELECT coalesce(array_agg(attname), '{}'::text[])
    FROM pg_attribute
   WHERE attrelid = p_table
     AND attnum > 0
     AND NOT attisdropped
     AND (attgenerated <> '' OR attname IN ('superseded_by','superseded_at'))
$$;

CREATE OR REPLACE FUNCTION datum.fn_assertions_no_mutate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
DECLARE
  v_exempt text[] := datum.immutability_exempt_columns('datum.assertions'::regclass);
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assertions are append-only: DELETE is never permitted (id=%)', OLD.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'assertions_are_append_only',
            DETAIL = json_build_object(
                       'reason', 'assertions_are_append_only',
                       'op', 'DELETE',
                       'id', OLD.id)::text,
            HINT = 'Correct a fact by inserting a new assertion with supersedes=<id>.';
  END IF;

  IF (to_jsonb(OLD) - v_exempt) IS DISTINCT FROM (to_jsonb(NEW) - v_exempt) THEN
    RAISE EXCEPTION 'assertions are immutable: UPDATE may only stamp supersession (id=%)', OLD.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'assertions_are_immutable',
            DETAIL = json_build_object(
                       'reason', 'assertions_are_immutable',
                       'op', 'UPDATE',
                       'id', OLD.id,
                       'changed', (
                         SELECT coalesce(json_agg(k), '[]'::json) FROM (
                           SELECT key AS k
                             FROM jsonb_each(to_jsonb(NEW)) n
                           WHERE NOT (key = ANY(v_exempt))
                              AND n.value IS DISTINCT FROM (to_jsonb(OLD) -> n.key)
                         ) d))::text,
            HINT = 'Corrections are new rows. Rewriting a stored event destroys as-of reproducibility.';
  END IF;

  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'assertion % is already superseded by %', OLD.id, OLD.superseded_by
      USING ERRCODE = '23514',
            CONSTRAINT = 'assertions_are_immutable',
            DETAIL = json_build_object(
                       'reason', 'assertions_are_immutable',
                       'op', 'UPDATE',
                       'id', OLD.id,
                       'already_superseded_by', OLD.superseded_by)::text;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_assertions_no_mutate ON datum.assertions;
CREATE TRIGGER trg_assertions_no_mutate
  BEFORE UPDATE OR DELETE ON datum.assertions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_assertions_no_mutate();

-- TRUNCATE bypasses row triggers entirely, so it needs its own statement-level guard.
CREATE OR REPLACE FUNCTION datum.fn_no_truncate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'assertions are append-only: TRUNCATE is never permitted'
    USING ERRCODE = '23514',
          CONSTRAINT = 'assertions_are_append_only',
          DETAIL = json_build_object('reason','assertions_are_append_only','op','TRUNCATE')::text;
END
$$;

DROP TRIGGER IF EXISTS trg_assertions_no_truncate ON datum.assertions;
CREATE TRIGGER trg_assertions_no_truncate
  BEFORE TRUNCATE ON datum.assertions
  FOR EACH STATEMENT EXECUTE FUNCTION datum.fn_no_truncate();

-- ---------------------------------------------------------------------------------------
-- Supersession — a correction is a new row, and the stamp is applied for it.
--
-- This runs BEFORE INSERT on purpose. The exclusion constraint is checked as the new tuple
-- lands, so the row being replaced must already have left the partial index by then;
-- stamping afterwards would make every legitimate correction of a `measured` fact collide
-- with the fact it corrects.
CREATE OR REPLACE FUNCTION datum.fn_apply_supersession()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = datum, pg_catalog AS $$
DECLARE
  v_target datum.assertions;
BEGIN
  IF NEW.supersedes IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_target FROM datum.assertions WHERE id = NEW.supersedes FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot supersede unknown assertion %', NEW.supersedes
      USING ERRCODE = '23514',
            CONSTRAINT = 'supersedes_target_not_found',
            DETAIL = json_build_object(
                       'reason','supersedes_target_not_found',
                       'supersedes', NEW.supersedes)::text;
  END IF;

  IF v_target.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'assertion % is already superseded by %; supersede the head of the chain instead',
                    v_target.id, v_target.superseded_by
      USING ERRCODE = '23514',
            CONSTRAINT = 'supersedes_target_already_superseded',
            DETAIL = json_build_object(
                       'reason','supersedes_target_already_superseded',
                       'supersedes', v_target.id,
                       'already_superseded_by', v_target.superseded_by,
                       'head', datum.chain_head(v_target.id))::text,
            HINT = 'A supersession chain has one live head. Fetch it, then supersede that.';
  END IF;

  UPDATE datum.assertions
     SET superseded_by = NEW.id,
         superseded_at = NEW.asserted_at
   WHERE id = NEW.supersedes;

  RETURN NEW;
END
$$;

-- Walk forward to the live end of a supersession chain. Used by the rejection above so the
-- error tells the caller what to do instead of just what went wrong.
CREATE OR REPLACE FUNCTION datum.chain_head(p_id text)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = datum, pg_catalog AS $$
DECLARE
  v_id   text := p_id;
  v_next text;
  v_hops int  := 0;
BEGIN
  LOOP
    SELECT superseded_by INTO v_next FROM datum.assertions WHERE id = v_id;
    IF v_next IS NULL OR v_hops > 10000 THEN
      RETURN v_id;
    END IF;
    v_id := v_next;
    v_hops := v_hops + 1;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS trg_assertions_apply_supersession ON datum.assertions;
CREATE TRIGGER trg_assertions_apply_supersession
  BEFORE INSERT ON datum.assertions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_apply_supersession();

-- ---------------------------------------------------------------------------------------
-- INVARIANT 4 — confidence is earned, never claimed.
--
-- An earlier draft made this a database check on the commit, which is unimplementable:
-- Postgres cannot run git. The right design is stronger — an agent simply cannot *say*
-- `measured`. Every agent write lands `unverified` (or `confirmed-by-human`, which is
-- testimony and labelled as such), and the verification worker promotes it only after
-- confirming the commit resolves and is contained where the evidence claims.
--
-- Explicit role membership only: superuser implicit membership is deliberately not
-- honoured, so this cannot be walked around by connecting as the owner.
CREATE OR REPLACE FUNCTION datum.is_verifier()
RETURNS boolean LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  SELECT current_user = 'datum_verifier'
      OR EXISTS (
           SELECT 1
             FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.roleid
             JOIN pg_roles g ON g.oid = m.member
            WHERE r.rolname = 'datum_verifier'
              AND g.rolname = current_user)
$$;

CREATE OR REPLACE FUNCTION datum.fn_confidence_is_earned()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
BEGIN
  IF NEW.confidence IN ('measured', 'derived') AND NOT datum.is_verifier() THEN
    RAISE EXCEPTION 'confidence % cannot be asserted; it is earned by verification', NEW.confidence
      USING ERRCODE = '23514',
            CONSTRAINT = 'confidence_is_earned',
            DETAIL = json_build_object(
                       'reason','confidence_is_earned',
                       'requested_confidence', NEW.confidence,
                       'permitted_confidence', json_build_array('unverified','confirmed-by-human'),
                       'actor', current_user)::text,
            HINT = 'Assert as unverified. The verification worker promotes it to measured once evidence.commit resolves and is contained where claimed.';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_assertions_confidence_is_earned ON datum.assertions;
CREATE TRIGGER trg_assertions_confidence_is_earned
  BEFORE INSERT ON datum.assertions
  FOR EACH ROW EXECUTE FUNCTION datum.fn_confidence_is_earned();
