-- 010 — preferences learned from repeated human feedback.
--
-- This is the highest-risk feature in the product, and it is worth being explicit about why.
-- "Learn what the user prefers from their feedback" is exactly what mem0 did, and a customer audit
-- of 10,134 of its production entries found 97.8% junk, including **808 copies of one hallucinated
-- "User prefers Vim"** manufactured by a recall to re-extraction feedback loop. Building this
-- naively does not produce a helpful assistant; it produces a confident liar at scale.
--
-- Four structural decisions keep it out of that hole. None of them is a filter someone can forget.
--
-- 1. THE SIGNAL IS THE REPETITION, NOT THE CONTENT.
--    Datum does not interpret what the human said. It counts distinct occasions on which the same
--    correction was reported. A count is an instrument fact, so this is not prose extraction and it
--    does not need the proposals queue. The counter IS the instrument.
--
-- 2. DEDUPLICATION IS BY OCCASION, NOT BY MENTION.
--    `UNIQUE (actor, signature, occasion)` means one human saying the same thing five times inside
--    one session counts ONCE. mem0's 808 duplicates came from re-processing the same source; this
--    constraint makes that arithmetically impossible rather than merely discouraged. "Repetition"
--    has to mean distinct occasions or it means nothing.
--
-- 3. CONFIDENCE IS EARNED BY CORROBORATION, exactly as `measured` is earned by verification.
--    One report is logged and nothing else happens. Repetition by one human earns a personal
--    preference. Corroboration by several humans earns an org-wide one — and note that
--    corroboration raises the SCOPE, not merely a score, which is what makes the existing scope
--    hierarchy do real work here.
--
-- 4. EVERY PREFERENCE IS AUDITABLE BACK TO ITS OCCASIONS.
--    A promoted preference cites the event ids that produced it, so "why do you think I prefer
--    this?" has a real answer with citations. mem0 could not answer that question about any of its
--    808 rows, which is precisely why nobody could clean it up.
--
-- The anti-loop rule, stated because it is a rule about code and not about data: whatever reports
-- feedback MUST NOT read this table to decide what to report. Feedback is a pure function of what
-- the human actually did. Reading it back is how the loop forms.

CREATE TABLE IF NOT EXISTS datum.feedback_events (
  id           text PRIMARY KEY,
  scope        text NOT NULL,
  -- The human who gave the feedback. Distinct actors are what turn a personal quirk into a rule.
  actor        text NOT NULL,
  -- A normalised key for "what this feedback is about", supplied by the caller rather than inferred.
  -- Structured input means repetition is exact-match counting instead of fuzzy clustering, and fuzzy
  -- clustering is where a system starts inventing agreement that was never there.
  signature    text NOT NULL,
  subject      text NOT NULL,
  predicate    text NOT NULL,
  -- What the human wanted instead. Stored verbatim; never parsed into a claim about the world.
  correction   jsonb NOT NULL,
  raw          text,
  -- The occasion: a session, a PR, a review. THIS is the unit of repetition.
  occasion     text NOT NULL,
  citation     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT feedback_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT feedback_signature_present CHECK (length(btrim(signature)) > 0),
  CONSTRAINT feedback_actor_present CHECK (length(btrim(actor)) > 0),
  CONSTRAINT feedback_occasion_present CHECK (length(btrim(occasion)) > 0),
  -- The constraint that makes 808 copies impossible.
  CONSTRAINT feedback_one_per_occasion UNIQUE (actor, signature, occasion)
);
CREATE INDEX IF NOT EXISTS feedback_by_signature ON datum.feedback_events (scope, signature, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_recent ON datum.feedback_events (created_at DESC);

CREATE TABLE IF NOT EXISTS datum.preferences (
  id             text PRIMARY KEY,
  scope          text NOT NULL,
  signature      text NOT NULL,
  subject        text NOT NULL,
  predicate      text NOT NULL,
  statement      text NOT NULL,
  -- Explainable tiers rather than a magic score. A number nobody can explain is a number nobody
  -- will trust enough to act on, and acting on it is the entire point.
  --   personal  one human, repeated              -> their preference, at their scope
  --   team      two distinct humans              -> corroborated
  --   org       three or more distinct humans    -> a rule the org holds
  tier           text NOT NULL,
  occasions      int NOT NULL,
  distinct_humans int NOT NULL,
  first_seen     timestamptz NOT NULL,
  last_seen      timestamptz NOT NULL,
  -- The event ids this was computed from. This is the audit trail that mem0 lacked.
  evidence_events text[] NOT NULL,
  -- The assertion this became, so the preference is readable through the normal read path.
  assertion_id   text REFERENCES datum.assertions(id),
  status         text NOT NULL DEFAULT 'active',
  -- Never mutated in place: a strengthened or retired preference supersedes its predecessor, so
  -- "when did this become an org rule?" stays answerable.
  supersedes     text REFERENCES datum.preferences(id),
  superseded_by  text REFERENCES datum.preferences(id) DEFERRABLE INITIALLY DEFERRED,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT preference_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT preference_tier_known CHECK (tier IN ('personal','team','org')),
  CONSTRAINT preference_status_known CHECK (status IN ('active','retired','rejected')),
  -- A preference is only a preference if it recurred. One report is an event, not a pattern.
  CONSTRAINT preference_requires_repetition CHECK (occasions >= 2),
  CONSTRAINT preference_tier_matches_corroboration CHECK (
    (tier = 'personal' AND distinct_humans = 1) OR
    (tier = 'team'     AND distinct_humans = 2) OR
    (tier = 'org'      AND distinct_humans >= 3)),
  -- Unfalsifiable provenance is the failure being designed against, so this is not optional.
  CONSTRAINT preference_cites_its_events CHECK (array_length(evidence_events, 1) >= 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS preferences_one_live_per_signature
  ON datum.preferences (scope, signature) WHERE superseded_by IS NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS preferences_active ON datum.preferences (scope, tier) WHERE status = 'active';

-- ---------------------------------------------------------------------------------------
-- What has recurred enough to be worth promoting, and at what tier.
--
-- Pure aggregation over the event log: no interpretation, no model, nothing to hallucinate. The
-- promoter reads this, the reporter never does.
CREATE OR REPLACE FUNCTION datum.preference_candidates(
  p_min_occasions int DEFAULT 2
) RETURNS TABLE (
  scope text, signature text, subject text, predicate text,
  occasions int, distinct_humans int, tier text,
  first_seen timestamptz, last_seen timestamptz,
  event_ids text[], latest_correction jsonb
) LANGUAGE sql STABLE SET search_path = datum, pg_catalog AS $$
  SELECT f.scope, f.signature, min(f.subject) AS subject, min(f.predicate) AS predicate,
         count(*)::int AS occasions,
         count(DISTINCT f.actor)::int AS distinct_humans,
         CASE WHEN count(DISTINCT f.actor) >= 3 THEN 'org'
              WHEN count(DISTINCT f.actor)  = 2 THEN 'team'
              ELSE 'personal' END AS tier,
         min(f.created_at) AS first_seen,
         max(f.created_at) AS last_seen,
         array_agg(f.id ORDER BY f.created_at) AS event_ids,
         (array_agg(f.correction ORDER BY f.created_at DESC))[1] AS latest_correction
    FROM datum.feedback_events f
   GROUP BY f.scope, f.signature
  HAVING count(*) >= p_min_occasions
$$;

GRANT SELECT, INSERT ON datum.feedback_events TO datum_app;
GRANT SELECT, INSERT ON datum.preferences     TO datum_app;
-- Strengthening and retirement happen by supersession, so only the stamp is mutable.
GRANT UPDATE (superseded_by, status) ON datum.preferences TO datum_app;
