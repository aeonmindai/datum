-- 008 — the code graph.
--
-- Code edges are deliberately NOT assertions, and the reason is invariant 3. One symbol calls many
-- others, so `subject=foo, predicate=calls` with two live targets over overlapping validity is a
-- direct exclusion-constraint violation: the database would refuse the second edge. Modelling the
-- graph as assertions would force us either to corrupt invariant 3 or to add `object` to its
-- exclusion key, weakening the single guarantee this product is built on.
--
-- It is also the right call semantically. A call edge is not a contested claim about the world; it
-- is a derived index of one commit. It needs no per-fact supersession — it needs to be pinned to a
-- commit and replaced wholesale when the commit changes.
--
-- What the graph DOES borrow from the assertion model is the confidence taxonomy, and that is the
-- differentiator. Sourcegraph, Glean, CodeQL and SCIP all give you edges; none of them tells you how
-- much to trust each edge. An impact answer that silently mixes compiler-resolved edges with
-- name-guessed ones is the code-intelligence equivalent of returning a bare number.

CREATE TABLE IF NOT EXISTS datum.code_index (
  id             text PRIMARY KEY,
  scope          text NOT NULL,
  repo           text NOT NULL,
  commit_sha     text NOT NULL,
  -- Bitemporality for free, and the thing LSIF/SCIP cannot do: indexes are never mutated, so
  -- "what called this in August" is a query rather than an impossibility.
  indexed_at     timestamptz NOT NULL DEFAULT now(),
  indexer        text NOT NULL,
  languages      text[] NOT NULL DEFAULT '{}',
  file_count     int NOT NULL DEFAULT 0,
  symbol_count   int NOT NULL DEFAULT 0,
  edge_count     int NOT NULL DEFAULT 0,
  -- Set once the loader has finished; a partial index must never answer a query.
  completed_at   timestamptz,
  stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT code_index_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT code_index_commit_shape CHECK (commit_sha ~ '^[0-9a-f]{7,40}$'),
  CONSTRAINT code_index_identity UNIQUE (repo, commit_sha, indexer)
);
CREATE INDEX IF NOT EXISTS code_index_live
  ON datum.code_index (repo, indexed_at DESC) WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS datum.code_symbols (
  id          bigserial PRIMARY KEY,
  index_id    text NOT NULL REFERENCES datum.code_index(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  name        text NOT NULL,
  -- Fully qualified where the language allows it; this is what edges resolve against.
  fqn         text,
  language    text NOT NULL,
  path        text NOT NULL,
  line_start  int  NOT NULL,
  line_end    int  NOT NULL,
  visibility  text,
  signature   text,
  -- A cheap change detector: if this moves, callers may need to care even when the name did not.
  signature_hash text,
  CONSTRAINT code_symbol_kind_known CHECK (kind IN
    ('function','method','type','trait','module','macro','test','constant','field','kernel')),
  CONSTRAINT code_symbol_lines_ordered CHECK (line_end >= line_start)
);
CREATE INDEX IF NOT EXISTS code_symbols_by_name  ON datum.code_symbols (index_id, name);
CREATE INDEX IF NOT EXISTS code_symbols_by_fqn   ON datum.code_symbols (index_id, fqn);
CREATE INDEX IF NOT EXISTS code_symbols_by_path  ON datum.code_symbols (index_id, path, line_start);
CREATE INDEX IF NOT EXISTS code_symbols_by_kind  ON datum.code_symbols (index_id, kind);

CREATE TABLE IF NOT EXISTS datum.code_edges (
  id          bigserial PRIMARY KEY,
  index_id    text NOT NULL REFERENCES datum.code_index(id) ON DELETE CASCADE,
  src_id      bigint NOT NULL REFERENCES datum.code_symbols(id) ON DELETE CASCADE,
  -- Null when the target could not be resolved to a symbol at all. The edge is still recorded,
  -- because "this calls something I could not find" is information, not noise.
  dst_id      bigint REFERENCES datum.code_symbols(id) ON DELETE CASCADE,
  dst_name    text NOT NULL,
  kind        text NOT NULL,
  -- The same four classes the rest of the store uses:
  --   measured   resolved by a compiler or language server. A fact.
  --   derived    exactly one symbol in the index bears this name. Sound, but inferred.
  --   unverified the name is ambiguous; `candidates` holds what it might have been.
  confidence  text NOT NULL,
  resolution  text NOT NULL,
  candidates  bigint[] NOT NULL DEFAULT '{}',
  path        text NOT NULL,
  line        int  NOT NULL,
  CONSTRAINT code_edge_kind_known CHECK (kind IN
    ('calls','imports','uses_type','implements','tests','references','instantiates')),
  CONSTRAINT code_edge_confidence_known CHECK (confidence IN ('measured','derived','unverified')),
  CONSTRAINT code_edge_resolution_known CHECK (resolution IN
    ('compiler','language-server','unique-name','ambiguous-name','unresolved')),
  -- An ambiguous edge is only honest if it carries what it might have meant.
  CONSTRAINT ambiguous_edges_carry_candidates CHECK (
    resolution <> 'ambiguous-name' OR coalesce(array_length(candidates, 1), 0) > 1),
  -- A `measured` edge must actually point at something. Confidence without a target is a lie.
  CONSTRAINT measured_edges_resolve CHECK (confidence <> 'measured' OR dst_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS code_edges_forward  ON datum.code_edges (index_id, src_id, kind);
-- The index that makes impact analysis fast: who reaches this symbol.
CREATE INDEX IF NOT EXISTS code_edges_reverse  ON datum.code_edges (index_id, dst_id, kind);
CREATE INDEX IF NOT EXISTS code_edges_by_name  ON datum.code_edges (index_id, dst_name);

-- ---------------------------------------------------------------------------------------
-- Impact analysis: the reverse dependency closure.
--
-- Returns every symbol that reaches the target, the depth at which it does, and the WEAKEST
-- confidence on the path that got there. That last column is the point: a caller found only through
-- an ambiguous hop is reported as `unverified`, so an agent can tell "this definitely breaks" from
-- "this might break". Silently promoting a guessed path to a certainty is exactly the failure this
-- store exists to refuse.
CREATE OR REPLACE FUNCTION datum.code_impact(
  p_index_id text,
  p_symbol_id bigint,
  p_max_depth int DEFAULT 4,
  p_kinds text[] DEFAULT NULL
) RETURNS TABLE (
  symbol_id bigint, depth int, path_confidence text, via_kind text,
  name text, fqn text, kind text, file_path text, line_start int
) LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  WITH RECURSIVE up AS (
    SELECT e.src_id AS symbol_id, 1 AS depth, e.confidence AS path_confidence, e.kind AS via_kind,
           ARRAY[e.src_id] AS seen
      FROM datum.code_edges e
     WHERE e.index_id = p_index_id
       AND e.dst_id = p_symbol_id
       AND (p_kinds IS NULL OR e.kind = ANY(p_kinds))
    UNION ALL
    SELECT e.src_id, u.depth + 1,
           -- The weakest link decides the path's trustworthiness.
           CASE WHEN 'unverified' IN (u.path_confidence, e.confidence) THEN 'unverified'
                WHEN 'derived'    IN (u.path_confidence, e.confidence) THEN 'derived'
                ELSE 'measured' END,
           e.kind, u.seen || e.src_id
      FROM datum.code_edges e
      JOIN up u ON e.dst_id = u.symbol_id
     WHERE e.index_id = p_index_id
       AND u.depth < p_max_depth
       AND NOT (e.src_id = ANY(u.seen))          -- cycles are normal in code; do not loop on them
       AND (p_kinds IS NULL OR e.kind = ANY(p_kinds))
  )
  SELECT DISTINCT ON (u.symbol_id)
         u.symbol_id, u.depth, u.path_confidence, u.via_kind,
         s.name, s.fqn, s.kind, s.path, s.line_start
    FROM up u JOIN datum.code_symbols s ON s.id = u.symbol_id
   -- Nearest, and most trustworthy, first.
   ORDER BY u.symbol_id, u.depth ASC,
            CASE u.path_confidence WHEN 'measured' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END
$$;

-- The newest completed index for a repo, which is what an unqualified query means.
CREATE OR REPLACE FUNCTION datum.latest_index(p_repo text)
RETURNS text LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  SELECT id FROM datum.code_index
   WHERE repo = p_repo AND completed_at IS NOT NULL
   ORDER BY indexed_at DESC LIMIT 1
$$;

GRANT SELECT, INSERT         ON datum.code_index   TO datum_app;
GRANT SELECT, INSERT         ON datum.code_symbols TO datum_app;
GRANT SELECT, INSERT         ON datum.code_edges   TO datum_app;
-- `completed_at` is stamped after the load finishes, so the index table alone needs UPDATE.
GRANT UPDATE (completed_at, symbol_count, edge_count, stats) ON datum.code_index TO datum_app;
GRANT USAGE, SELECT ON SEQUENCE datum.code_symbols_id_seq TO datum_app;
GRANT USAGE, SELECT ON SEQUENCE datum.code_edges_id_seq   TO datum_app;
