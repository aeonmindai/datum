-- 001 — schema, roles, ordering sequence.
--
-- Privilege separation is how invariants 2 and 4 are enforced by the *database*
-- rather than by the application:
--
--   datum_owner    owns everything (in practice: whoever DATABASE_URL connects as)
--   datum_app      SELECT + INSERT on assertions. No UPDATE. No DELETE.       (invariant 2)
--   datum_verifier datum_app + the right to insert `measured`/`derived` rows.  (invariant 4)
--
-- One DATABASE_URL is all a self-hoster has to supply. The server runs migrations as the
-- connecting role, then `SET ROLE datum_app` (or datum_verifier for the worker) on every
-- pooled connection, so runtime traffic never holds owner privileges.

CREATE SCHEMA IF NOT EXISTS datum;

-- btree_gist: trusted since PG13, ships in contrib. Needed so `scope`, `subject` and
-- `predicate` (text, equality) can share one GiST index with `valid_period` (overlap).
-- This is deliberately NOT PG18 `WITHOUT OVERLAPS`: identical guarantee, hardened since
-- PG9.x, runs on PG13+, keeps the host swappable.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datum_app') THEN
    CREATE ROLE datum_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'datum_verifier') THEN
    CREATE ROLE datum_verifier NOLOGIN;
  END IF;
  -- datum_verifier inherits everything datum_app can do, and adds the promotion right.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles g ON g.oid = m.member
     WHERE r.rolname = 'datum_app' AND g.rolname = 'datum_verifier'
  ) THEN
    GRANT datum_app TO datum_verifier;
  END IF;
END
$$;

-- Let the connecting role hand these roles out to itself via SET ROLE.
DO $$
BEGIN
  EXECUTE format('GRANT datum_app TO %I WITH ADMIN OPTION', current_user);
  EXECUTE format('GRANT datum_verifier TO %I WITH ADMIN OPTION', current_user);
EXCEPTION WHEN OTHERS THEN
  -- Already a member, or we are a superuser who does not need the grant. Either is fine.
  NULL;
END
$$;

GRANT USAGE ON SCHEMA datum TO datum_app;

-- `asserted_at` is assert-time: a monotonic sequence, never a clock. A free total order
-- across every key with no skew. (NATS JetStream KV's bucket revision counter is the
-- production precedent.)
CREATE SEQUENCE IF NOT EXISTS datum.assert_seq AS bigint START 1;
GRANT USAGE, SELECT ON SEQUENCE datum.assert_seq TO datum_app;

-- Scope helpers. Nothing here knows or cares what the root label is: `DATUM_ORG` is
-- configuration and no query may assume the org root is the top of the tree (§15.1).
CREATE OR REPLACE FUNCTION datum.scope_labels(p_scope text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT string_to_array(p_scope, '/')
$$;

-- 'org/a/proj/b' -> {'org','org/a','org/a/proj','org/a/proj/b'}
-- Ordered shortest-first; the caller reverses for nearest-scope-wins.
CREATE OR REPLACE FUNCTION datum.scope_ancestors(p_scope text)
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT array_agg(array_to_string(l[1:i], '/') ORDER BY i)
    FROM datum.scope_labels(p_scope) AS l,
         generate_subscripts(l, 1) AS i
$$;

CREATE OR REPLACE FUNCTION datum.scope_depth(p_scope text)
RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT array_length(datum.scope_labels(p_scope), 1)
$$;
