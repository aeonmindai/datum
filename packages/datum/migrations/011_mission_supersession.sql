-- 011 - make mission supersession actually work.
--
-- `datum.missions` has had `supersedes`, `superseded_by`, an immutability trigger and
-- `fn_missions_apply_supersession` since 005. None of it could ever succeed.
--
-- The supersession stamp is applied by a BEFORE INSERT trigger, which sets the *target's*
-- `superseded_by` to the id of the row currently being inserted - a row that does not exist yet.
-- An immediate foreign key rejects that with 23503 every time. Assertions hit this in 002 and
-- solved it there by deferring the FK to commit; missions were written the same way and the fix
-- was never carried across, because no seed or test ever superseded a mission. A capability with
-- a trigger, two columns and zero working call sites is worse than no capability: the schema
-- advertises it.
--
-- Deferring this FK costs nothing. It is bookkeeping - which row replaced which - not an
-- invariant. The rules that must stay immediate are the ones that make a bad row un-insertable
-- rather than merely un-committable: `gates_must_be_machine_checkable`, and the refusal in
-- `fn_missions_apply_supersession` to re-supersede an already-superseded mission. Both are
-- untouched here.
--
-- Idempotent: the constraint is only rebuilt if it is not already deferrable.

DO $$
DECLARE
  v_name text;
  v_deferrable boolean;
BEGIN
  SELECT c.conname, c.condeferrable
    INTO v_name, v_deferrable
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'datum'
     AND t.relname = 'missions'
     AND c.contype = 'f'
     AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = t.oid AND attname = 'superseded_by')]::smallint[];

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'no foreign key found on datum.missions(superseded_by)';
  END IF;

  IF v_deferrable THEN
    RAISE NOTICE 'missions(superseded_by) FK is already deferrable; nothing to do';
    RETURN;
  END IF;

  EXECUTE format('ALTER TABLE datum.missions DROP CONSTRAINT %I', v_name);
  ALTER TABLE datum.missions
    ADD CONSTRAINT missions_superseded_by_fkey
    FOREIGN KEY (superseded_by) REFERENCES datum.missions(id) DEFERRABLE INITIALLY DEFERRED;
END
$$;
