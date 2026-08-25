-- 012 - episodes: what was said, as opposed to what is true.
--
-- The whole product so far holds *claims about the world*, each one needing a receipt before it
-- counts. That discipline is why it never states a falsehood, and it is also why everything said
-- in a conversation and never written down is lost. Measured on the real corpus: the single most
-- consequential sentence in eleven days of Arc work - "we reached the 60-minute bake once, then
-- model confusion happened" - existed in no file, no commit and no note. It reframed an entire
-- phase and it survived only because somebody happened to ask the right question.
--
-- An episode is not a fact. It is a record that an utterance occurred: who, when, on which
-- branch, in which session. That distinction is the entire safety argument, because the failure
-- mode of every memory product is extracting facts from prose and then re-extracting from its own
-- output - one audited deployment held 10,134 entries, 97.8% junk, including 808 copies of a
-- single hallucinated preference. Arc's own corpus has the same disease: 449 correction markers
-- across 21,619 lines, and the retracted 16,600 outnumbering the live 14,000 by 19 hits to zero.
--
-- So the rule enforced here, by the database rather than by good intentions:
--
--   an episode may be CITED as the evidence for a fact, and a fact whose evidence is an
--   episode can never be `measured` or `derived`.
--
-- Which means a conversation can support "a named human said so" and nothing stronger. It can
-- never close a gate, because `datum.evaluate_gate` reads assertions at an exact confidence class
-- and no episode-backed row can ever reach the two classes only the verifier may write. Promotion
-- from conversation to fact stays an explicit act by a person or an instrument. Never automatic.
--
-- Retrieval here may be fuzzy, and that is not a contradiction of the no-guessing rule. Handing
-- back a near-miss *number* is a lie. Handing back a near-miss *quote*, stamped with who said it
-- and when, is a citation the reader judges for themselves.

CREATE TABLE IF NOT EXISTS datum.episodes (
  id             text PRIMARY KEY,
  scope          text NOT NULL,

  -- Which conversation, and where in it. `seq` is the position within the session as ingested,
  -- so "what came next" is answerable without parsing timestamps.
  session_id     text NOT NULL,
  seq            int  NOT NULL,
  parent_id      text REFERENCES datum.episodes(id) DEFERRABLE INITIALLY DEFERRED,

  -- Who spoke and when. `actor` follows the same shape as assertions.asserted_by, so a human in
  -- one plane is the same identity as a human in the other.
  occurred_at    timestamptz NOT NULL,
  actor          text NOT NULL,
  role           text NOT NULL,

  text           text NOT NULL,

  -- Provenance of the moment, not of the claim. A transcript records the branch and directory the
  -- speaker was standing in, which is exactly the qualifier that compaction strips: "757.5" is
  -- indistinguishable from "757.5 on release/openrouter-ready" once the context is summarised.
  git_branch     text,
  git_commit     text,
  cwd            text,

  -- Where the bytes came from, so any episode can be checked against the original.
  source         jsonb NOT NULL,

  -- Content-addressed, so re-ingesting a transcript is a no-op rather than a duplicate. Learned
  -- the hard way: seeds without a stable identity minted fresh rows on every load.
  hash           text NOT NULL UNIQUE,

  ingested_at    timestamptz NOT NULL DEFAULT now(),
  episode_fts    tsvector,

  CONSTRAINT episode_id_shape CHECK (id ~ '^e_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT episode_scope_shape CHECK (scope ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'),
  CONSTRAINT episode_hash_shape CHECK (hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT episode_role_known CHECK (role IN ('human','agent','system')),
  CONSTRAINT episode_actor_shape CHECK (actor ~ '^(human|agent|service|worker):[A-Za-z0-9_.@:-]+$'),
  CONSTRAINT episode_text_present CHECK (length(btrim(text)) > 0),
  CONSTRAINT episode_seq_sane CHECK (seq >= 0),
  -- An episode always says where it came from, for the same reason a fact always says how it was
  -- earned. An unsourced quote is a rumour with a timestamp.
  CONSTRAINT episode_source_shape CHECK (
    source IS NOT NULL AND jsonb_typeof(source) = 'object'
    AND source ? 'kind' AND length(btrim(source->>'kind')) > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS episodes_session_seq ON datum.episodes (session_id, seq);
CREATE INDEX IF NOT EXISTS episodes_scope_time ON datum.episodes (scope, occurred_at DESC);
CREATE INDEX IF NOT EXISTS episodes_actor_time ON datum.episodes (actor, occurred_at DESC);
CREATE INDEX IF NOT EXISTS episodes_branch ON datum.episodes (git_branch) WHERE git_branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS episodes_fts ON datum.episodes USING gin (episode_fts);
-- Trigram index so a symbol or path mentioned mid-sentence is findable without tokenising it the
-- way English is tokenised. `qtip2b_grouped_gemm` is one word to Postgres and zero words to a
-- human search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS episodes_text_trgm ON datum.episodes USING gin (text gin_trgm_ops);

CREATE OR REPLACE FUNCTION datum.fn_episodes_fts()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
BEGIN
  NEW.episode_fts := to_tsvector('english', coalesce(NEW.text, ''));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_episodes_fts ON datum.episodes;
CREATE TRIGGER trg_episodes_fts
  BEFORE INSERT ON datum.episodes
  FOR EACH ROW EXECUTE FUNCTION datum.fn_episodes_fts();

-- ---------------------------------------------------------------------------------------------
-- Immutability. Same two-layer defence as assertions: privilege revocation stops the app roles,
-- and a trigger stops everyone including the owner. A transcript that can be edited after the
-- fact is worth less than no transcript, because it invites exactly one kind of edit.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION datum.fn_episodes_no_mutate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = datum, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'episodes are append-only; % refused', TG_OP
      USING ERRCODE = '23514', CONSTRAINT = 'episodes_are_immutable',
            DETAIL = json_build_object('reason','episodes_are_immutable','id',OLD.id)::text;
  END IF;
  RAISE EXCEPTION 'episodes are append-only; % refused', TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'episodes_are_immutable',
          DETAIL = json_build_object('reason','episodes_are_immutable','id',NEW.id)::text;
END
$$;

DROP TRIGGER IF EXISTS trg_episodes_no_mutate ON datum.episodes;
CREATE TRIGGER trg_episodes_no_mutate
  BEFORE UPDATE OR DELETE ON datum.episodes
  FOR EACH ROW EXECUTE FUNCTION datum.fn_episodes_no_mutate();

-- ---------------------------------------------------------------------------------------------
-- THE LOAD-BEARING INVARIANT: a conversation is evidence, never a measurement.
--
-- `evidence.episode` names an episode this claim rests on. A row that rests on one cannot be
-- `measured` or `derived`, so no amount of talking can close a gate that demands either. The
-- verifier writes those two classes and the verifier only trusts git.
-- ---------------------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'episode_evidence_is_never_measured') THEN
    ALTER TABLE datum.assertions ADD CONSTRAINT episode_evidence_is_never_measured
      CHECK (
        NOT (evidence ? 'episode')
        OR confidence NOT IN ('measured','derived')
      );
  END IF;
END
$$;

GRANT SELECT, INSERT ON datum.episodes TO datum_app;
GRANT SELECT ON datum.episodes TO datum_verifier;
REVOKE UPDATE, DELETE, TRUNCATE ON datum.episodes FROM datum_app, datum_verifier;
