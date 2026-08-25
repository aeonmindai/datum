-- 009 — proposals: the only channel through which prose may ever influence the record.
--
-- A customer audit of 10,134 mem0 production entries found 97.8% junk, including 808 copies of one
-- hallucinated preference manufactured by a recall to re-extraction feedback loop. The lesson is not
-- "never read prose" — it is that an extractor must never write to the thing it later reads.
--
-- So proposals are quarantined by construction:
--   * they live in their own table, not in `assertions`
--   * `/v1/ask` and every MCP tool are physically incapable of returning them
--   * promotion is an ordinary INSERT into assertions, which means it passes every invariant:
--     evidence required, confidence earned, contradictions detected
--   * an extractor may not read them, so the recall to re-extraction loop cannot form
--
-- Review is therefore "confirm this file:line citation", not "trust an extractor".

CREATE TABLE IF NOT EXISTS datum.proposals (
  id           text PRIMARY KEY,
  scope        text NOT NULL,
  subject      text NOT NULL,
  predicate    text NOT NULL,
  object       jsonb NOT NULL,
  claim        text,
  kind         text NOT NULL,
  -- Where in the prose this came from. This is the whole point: a reviewer checks the citation
  -- rather than the extractor's judgement.
  citation     jsonb NOT NULL,
  extractor    text NOT NULL,
  -- The extractor's own confidence in itself. Deliberately NOT the assertion confidence taxonomy:
  -- a proposal has earned nothing, and reusing those words here would invite promoting the label
  -- along with the row.
  extractor_confidence numeric,
  status       text NOT NULL DEFAULT 'pending',
  -- Set when accepted: the assertion this became. The audit trail from prose to record.
  promoted_to  text REFERENCES datum.assertions(id),
  reviewed_by  text,
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT proposal_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT proposal_status_known CHECK (status IN ('pending','accepted','rejected','superseded')),
  CONSTRAINT proposal_kind_known CHECK (kind IN
    ('measured','target','rule','constraint','state','untried','failed','dead')),
  -- A proposal with no citation is an extractor's opinion, which is the thing being guarded against.
  CONSTRAINT proposal_requires_citation CHECK (
    jsonb_typeof(citation) = 'object'
    AND citation ? 'source'
    AND length(btrim(citation->>'source')) > 0),
  -- Accepting a proposal without naming what it became would break the audit trail.
  CONSTRAINT accepted_proposals_name_their_assertion CHECK (
    status <> 'accepted' OR promoted_to IS NOT NULL),
  CONSTRAINT reviewed_proposals_have_a_reviewer CHECK (
    status = 'pending' OR reviewed_by IS NOT NULL),
  -- One pending proposal per claim, so a re-run of the extractor cannot manufacture duplicates.
  -- This is the constraint that makes 808 copies of one claim impossible.
  CONSTRAINT proposal_identity UNIQUE (scope, subject, predicate, extractor, status)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS proposals_pending
  ON datum.proposals (created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS proposals_by_subject ON datum.proposals (scope, subject, predicate);

-- Extraction is a suggestion channel, so the app may write and read proposals directly. What it
-- must never do is surface them as facts, and that is enforced in the read path: `datum.take`,
-- `datum.search` and every MCP tool query `assertions` and have no join to this table at all.
-- The guarantee is structural rather than a filter someone could forget.
GRANT SELECT, INSERT ON datum.proposals TO datum_app;
GRANT UPDATE (status, promoted_to, reviewed_by, reviewed_at, review_note)
  ON datum.proposals TO datum_app;
