-- 014 — retention for the code graph.
--
-- One Arc index is 19,177 symbols and 126,897 edge rows. Every index is currently kept forever, so
-- at twenty commits a day the graph alone outgrows a 10 GB volume inside a fortnight. Automating
-- the indexer without bounding what it writes would be actively harmful, so the bound lands with
-- the trigger rather than after it: keep the newest few completed indexes per repo, drop the rest.
--
-- This is the first DELETE grant in the schema and it does not get to be assumed.
--
-- The code graph is DERIVED data. Every row in it is regenerable from git by re-running the
-- indexer over the same commit, which is exactly why 008 models edges as an index rather than as
-- assertions: a call edge is not a contested claim about the world, it is a projection of one
-- tree. Deleting an index destroys no testimony and forecloses no question — the same commit
-- re-indexed produces the same graph.
--
-- The ledger's immutability is untouched, and it is untouched mechanically rather than by
-- convention:
--   002  REVOKE UPDATE, DELETE, TRUNCATE ON assertions, verifications FROM datum_app, datum_verifier
--   005  the same revoke on missions;  012 on episodes;  013 on node_activity
--   003/012/013 additionally install BEFORE UPDATE OR DELETE triggers that RAISE for *every* role,
--        owner included, so the guarantee does not rest on a grant at all.
-- This migration grants DELETE on exactly one table, and asserts the rest of that below rather
-- than asking a reader to trust the paragraph.
--
-- Nothing outside the three code tables references them. code_symbols.index_id and
-- code_edges.index_id are ON DELETE CASCADE, code_edges.src_id/dst_id cascade from code_symbols,
-- and assertions.derived_from holds assertion ids — never symbol ids. So one DELETE on code_index
-- removes exactly one index's rows and touches no ledger row. The cascade needs no grant of its
-- own: PostgreSQL runs referential actions with the privileges of the referencing table's owner,
-- which is why code_symbols and code_edges stay INSERT/SELECT-only for the runtime roles.

GRANT DELETE ON datum.code_index TO datum_app;
-- datum_verifier is a member of datum_app (001) and therefore inherits this. That is the existing
-- shape of the privilege graph — verifier is app plus evidence writes — and not a second decision.

-- ---------------------------------------------------------------------------------------
-- The invariant this migration must not move, asserted rather than asserted-to.
--
-- If a future edit widens the grant above into a blanket one, this block fails the migration on
-- the next boot instead of quietly handing an agent role the ability to erase testimony.
-- ---------------------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT role, tbl, priv
      FROM (VALUES ('datum_app'), ('datum_verifier')) AS a(role),
           (VALUES ('assertions'), ('episodes'), ('missions'), ('node_activity')) AS b(tbl),
           (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS c(priv)
  LOOP
    IF has_table_privilege(r.role, 'datum.' || r.tbl, r.priv) THEN
      RAISE EXCEPTION '% holds % on datum.%; the ledger is append-only for every runtime role',
        r.role, r.priv, r.tbl
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END
$$;
