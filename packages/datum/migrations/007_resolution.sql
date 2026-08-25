-- 007 — retrieval. Exact-first, supersession-aware, nearest-scope-wins, as-of capable.
--
-- Order of operations is fixed and not negotiable: structured filter (index seek), then
-- full text, then — later, and never as a fact — embeddings. Vector similarity returns
-- "close enough" with no signal that it is the wrong neighbour, which is the exact failure
-- mode this system exists to eliminate.
--
-- `p_chain` is the resolved scope chain, NEAREST FIRST. The caller builds it, because
-- global-vs-isolated decides where the chain stops, and because nothing in here may assume
-- the configured org root is the top of the tree (§15.1).

-- Take a datum. Returns one row per (subject, predicate) from the nearest scope in the
-- chain that has one — except where that scope holds a genuine disagreement, in which case
-- it returns BOTH sides marked contested, because silently picking one is the single
-- behaviour every competitor gets wrong.
CREATE OR REPLACE FUNCTION datum.take(
  p_chain      text[],
  p_subject    text    DEFAULT NULL,
  p_predicate  text    DEFAULT NULL,
  p_kind       text    DEFAULT NULL,
  p_asof       bigint  DEFAULT NULL,
  p_limit      int     DEFAULT 50
) RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  WITH cand AS (
    SELECT a.*,
           c.ord,
           min(c.ord) OVER (PARTITION BY a.subject, a.predicate) AS best_ord
      FROM datum.assertions a
      JOIN unnest(p_chain) WITH ORDINALITY AS c(scope, ord) ON c.scope = a.scope
     WHERE CASE
             -- Default read: live only. A superseded assertion must never surface, or
             -- append-only performs worse than having no memory at all.
             WHEN p_asof IS NULL THEN a.superseded_by IS NULL
             -- As-of read on the assert-time axis: what did we believe at sequence N.
             ELSE a.asserted_at <= p_asof
                  AND (a.superseded_at IS NULL OR a.superseded_at > p_asof)
           END
       AND (p_subject   IS NULL OR a.subject   = p_subject)
       AND (p_predicate IS NULL OR a.predicate = p_predicate)
       AND (p_kind      IS NULL OR a.kind      = p_kind)
       -- `kind = 'dead'` is excluded unless it is asked for by name. A retired number is not a
       -- fact about the world; it is a record that a claim is refused. Arc's corpus carried 449
       -- in-place retraction markers across 21,619 lines, and at 500k context retrieval returned
       -- the most *emphatic* match rather than the most recent, so dead headline numbers won
       -- every time and the live target appeared nowhere. Labelling them was not enough; they
       -- have to be absent from the default read, and reachable with kind='dead' when someone
       -- wants to audit exactly what the store refuses to surface.
       AND (p_kind = 'dead' OR a.kind <> 'dead')
  )
  SELECT to_jsonb(x) - 'ord' - 'best_ord' - 'claim_fts'
    FROM (
      SELECT cand.*,
             EXISTS (SELECT 1 FROM datum.contradictions k
                      WHERE k.status = 'open'
                        AND (k.a_id = cand.id OR k.b_id = cand.id)) AS contested,
             -- §5 edge case, handled rather than discovered: a derived assertion whose
             -- inputs are no longer resolvable (the project went isolated) is flagged, not
             -- silently kept. Silently keeping it is the exact stale-fact bug this exists
             -- to prevent.
             (cand.confidence = 'derived'
              AND EXISTS (
                SELECT 1 FROM unnest(cand.derived_from) AS f(id)
                 WHERE NOT EXISTS (
                   SELECT 1 FROM datum.assertions i
                    WHERE i.id = f.id AND i.scope = ANY(p_chain)))) AS inputs_unresolvable
        FROM cand
       WHERE cand.ord = cand.best_ord
       ORDER BY cand.scope_depth DESC, cand.asserted_at DESC
       LIMIT p_limit
    ) x
$$;

-- Full text, second. Scoped to the same chain and the same live-only rule.
CREATE OR REPLACE FUNCTION datum.search(
  p_chain text[],
  p_query text,
  p_limit int DEFAULT 25
) RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  SELECT to_jsonb(x) - 'claim_fts'
    FROM (
      SELECT a.*, ts_rank(a.claim_fts, websearch_to_tsquery('english', p_query)) AS rank
        FROM datum.assertions a
       WHERE a.superseded_by IS NULL
         AND a.scope = ANY(p_chain)
         AND a.claim_fts @@ websearch_to_tsquery('english', p_query)
       ORDER BY rank DESC, a.asserted_at DESC
       LIMIT p_limit
    ) x
$$;

-- The supersession chain for one assertion, oldest first. This is the as-of feature's
-- backing query and the panel's history view.
CREATE OR REPLACE FUNCTION datum.lineage(p_id text)
RETURNS SETOF jsonb LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  WITH RECURSIVE back AS (
    SELECT a.* FROM datum.assertions a WHERE a.id = p_id
    UNION ALL
    SELECT p.* FROM datum.assertions p JOIN back b ON p.id = b.supersedes
  ), fwd AS (
    SELECT a.* FROM datum.assertions a WHERE a.id = p_id
    UNION ALL
    SELECT n.* FROM datum.assertions n JOIN fwd f ON n.id = f.superseded_by
  )
  SELECT to_jsonb(x) - 'claim_fts' FROM (
    SELECT * FROM back UNION SELECT * FROM fwd
  ) x ORDER BY (x.asserted_at)
$$;
