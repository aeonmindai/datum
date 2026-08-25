import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { Rejection } from "../domain/errors.js";
import { newId } from "../domain/identity.js";
import { assertFact } from "../domain/store.js";
import { authenticateKey, requirePermission, requireScope } from "../http/auth.js";
import { sendRejection } from "../http/v1.js";
import { activePreferences } from "./read.js";
import { recordFeedback } from "./record.js";
import { rejectionSignature } from "./signature.js";
import {
  PREFERENCE_PREDICATE,
  PREFERENCE_SUBJECT_PREFIX,
  REJECTION_PREDICATE,
  type PreferenceRow,
} from "./types.js";

/**
 * The three surfaces: report a correction, read what has been learned, and take it back.
 *
 * The third one is not a courtesy. A preference the org cannot revoke is a preference that becomes
 * immortal the moment it is wrong, and mem0's audit is what that looks like — 97.8% junk that nobody
 * could clean up, because nothing recorded where any of it came from or offered a way out.
 */

const ScopeString = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/, "scope must be slash-separated labels");

// Zod reports a missing field as "expected string, received undefined" unless the schema names its
// own error. These sentences are the API's whole answer to "what did I do wrong", and they have to
// read the same whether the field was absent or blank.
const ACTOR_REQUIRED = "actor is required: a preference has to be attributable to a human";
const OCCASION_REQUIRED = "occasion is required: it is the unit of repetition";
const REASON_REQUIRED = "reason is required: a rejection has to say what was wrong";
const REJECTER_REQUIRED = "actor is required: name the human rejecting this";

const FeedbackBody = z.object({
  scope: ScopeString,
  // The human who gave the feedback, named. Distinct humans are what raise a personal quirk to an
  // org-wide rule, so this is the field the tier ladder is computed from and it is required.
  actor: z.string({ error: ACTOR_REQUIRED }).min(1, ACTOR_REQUIRED),
  subject: z.string().min(1),
  predicate: z
    .string()
    .min(1)
    .refine((p) => p !== REJECTION_PREDICATE, {
      message: `${REJECTION_PREDICATE} is reserved for rejections recorded by POST /v1/preferences/:id/reject`,
    }),
  correction: z.record(z.string(), z.unknown()),
  occasion: z.string({ error: OCCASION_REQUIRED }).min(1, OCCASION_REQUIRED),
  signature: z.string().min(1).optional(),
  raw: z.string().nullish(),
  citation: z.record(z.string(), z.unknown()).optional(),
});

const RejectBody = z.object({
  // Required. A rejection with no stated reason is unreviewable, and it becomes the `why` on the
  // assertion that retires the preference — where `failure_requires_why` insists on it anyway.
  reason: z.string({ error: REASON_REQUIRED }).min(1, REASON_REQUIRED),
  actor: z.string({ error: REJECTER_REQUIRED }).min(1, REJECTER_REQUIRED),
});

export interface PreferenceDeps {
  db: Db;
  config: Config;
}

/** Mirrors `parse` in http/v1.ts, which is module-private there. Same rejection, same reason code. */
function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Rejection({
      reason: "malformed_request",
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
      detail: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

const PREFERENCE_BY_ID_SQL = `
  SELECT id, scope, signature, subject, predicate, statement, tier, occasions, distinct_humans,
         first_seen, last_seen, evidence_events, assertion_id, status, supersedes, superseded_by,
         created_at
    FROM datum.preferences WHERE id = $1`;

export function registerPreferenceRoutes(app: FastifyInstance, deps: PreferenceDeps): void {
  const { db, config } = deps;

  const auth = async (
    request: FastifyRequest,
    permission: "read" | "assert" | "supersede",
  ): Promise<{ id: string; label: string; scope: string; permissions: string[] }> => {
    // Authenticate BEFORE validating input, and scope-check after. The ordering is a security
    // property, not a style choice: parsing first lets an anonymous caller probe the request schema
    // by reading 400s, and makes the same endpoint answer 400 to a stranger and 401 to a
    // half-configured client, which is exactly backwards.
    const key = await authenticateKey(db, request.headers.authorization);
    requirePermission(key, permission);
    return key;
  };

  app.post("/v1/feedback", async (request, reply) => {
    let actor: string | null = null;
    let body: z.output<typeof FeedbackBody> | null = null;
    try {
      const key = await auth(request, "assert");
      body = parseBody(FeedbackBody, request.body);
      requireScope(key, body.scope);
      actor = body.actor;

      const recorded = await recordFeedback(db, {
        ...body,
        raw: body.raw ?? null,
        // The reporting key is recorded alongside the human it reports for, so a key that manages to
        // name three humans on its own is visible in the citation of every event it wrote. The tier
        // ladder trusts the actor; the audit trail does not have to.
        citation: { ...(body.citation ?? {}), reported_by: `key:${key.label}` },
      });

      return reply.code(recorded.created ? 201 : 200).send({
        ok: true,
        created: recorded.created,
        event_id: recorded.id,
        signature: recorded.signature,
        occasions: recorded.occasions,
        distinct_humans: recorded.distinctHumans,
        // Say plainly what happened, including when nothing did. One report is an event, not a
        // pattern, and a caller that believes it just taught the store something is a caller that
        // will stop reporting.
        note: recorded.created
          ? recorded.occasions < 2
            ? "recorded. one occasion is an event, not a pattern: nothing is learned until the same correction recurs on a different occasion."
            : `recorded. ${recorded.occasions} occasions from ${recorded.distinctHumans} distinct human(s); the promoter decides the tier.`
          : "already recorded for this actor on this occasion. saying it five times in one session counts once, by construction.",
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, {
        actor,
        scope: body?.scope,
        subject: body?.subject,
        predicate: body?.predicate,
      });
    }
  });

  app.get("/v1/preferences", async (request, reply) => {
    try {
      const key = await auth(request, "read");
      const query = parseBody(z.object({ scope: ScopeString }), request.query);
      requireScope(key, query.scope);
      const preferences = await activePreferences(db, query.scope);
      return reply.send({ ok: true, scope: query.scope, preferences });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor: null });
    }
  });

  app.post("/v1/preferences/:id/reject", async (request, reply) => {
    let actor: string | null = null;
    let scope: string | undefined;
    try {
      // Retiring a learned rule is a supersession, so it takes the supersede permission.
      const key = await auth(request, "supersede");
      const params = parseBody(z.object({ id: z.string().min(1) }), request.params);
      const body = parseBody(RejectBody, request.body);
      actor = body.actor;

      const pref = await db.one<PreferenceRow>("app", PREFERENCE_BY_ID_SQL, [params.id]);
      if (!pref) {
        throw new Rejection({ reason: "not_found", message: `no preference ${params.id}` });
      }
      scope = pref.scope;
      requireScope(key, pref.scope);

      if (pref.superseded_by) {
        throw new Rejection({
          reason: "supersedes_target_already_superseded",
          message: `preference ${pref.id} was already superseded by ${pref.superseded_by}; reject the live head instead`,
          detail: { preference: pref.id, superseded_by: pref.superseded_by },
          hint: "GET /v1/preferences?scope=… lists the live head for every signature.",
        });
      }
      if (pref.status === "rejected") {
        // Already taken back. Rejecting twice must not manufacture a second counter-event or a
        // second superseding assertion; the escape hatch is idempotent.
        return reply.send({ ok: true, rejected: true, already_rejected: true, preference: pref });
      }

      const rejection = await db.tx("app", async (client) => {
        // The counter-event: a human did something, so it is recorded as a thing a human did.
        //
        // It carries a signature of its own and the reserved `rejected_learned_preference`
        // predicate, both so that it can never be counted towards the preference it rejects. Under
        // the rejected preference's own signature a rejection would *strengthen* the thing it
        // rejects, and the promoter skips this predicate so that two humans rejecting the same row
        // cannot corroborate each other into a new rule either.
        //
        // ON CONFLICT is declared rather than caught: this statement runs inside a transaction this
        // route owns, and a unique violation would poison it — aborting a legitimate rejection over
        // a duplicate audit row. A duplicate here is genuinely a no-op.
        await client.query(
          `INSERT INTO datum.feedback_events
             (id, scope, actor, signature, subject, predicate, correction, raw, occasion, citation)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb)
           ON CONFLICT (actor, signature, occasion) DO NOTHING`,
          [
            newId("fb"),
            pref.scope,
            body.actor,
            rejectionSignature(pref.id),
            pref.subject,
            REJECTION_PREDICATE,
            JSON.stringify({
              rejected_preference: pref.id,
              rejected_signature: pref.signature,
              rejected_tier: pref.tier,
              reason: body.reason,
            }),
            body.reason,
            `reject:${pref.id}`,
            JSON.stringify({ reported_by: `key:${key.label}`, statement: pref.statement }),
          ],
        );

        // `status` is one of the two columns the grant makes mutable, exactly for this. The row
        // itself is not touched otherwise and is never deleted: the tier history it sits at the end
        // of stays walkable, including the fact that it was rejected rather than merely superseded.
        await client.query(`UPDATE datum.preferences SET status = 'rejected' WHERE id = $1`, [
          pref.id,
        ]);

        if (!pref.assertion_id) return null;
        // A rejected preference is a dead end that carries its own falsifier, which is what `dead`
        // means here and why the schema insists on `why`. The human's reason IS the falsifier.
        return assertFact(
          db,
          {
            scope: pref.scope,
            subject: `${PREFERENCE_SUBJECT_PREFIX}${pref.signature}`,
            predicate: PREFERENCE_PREDICATE,
            object: {
              rejected: true,
              reason: body.reason,
              statement: pref.statement,
              rejected_preference: pref.id,
              was_tier: pref.tier,
            },
            claim: `rejected: ${pref.statement} — ${body.reason}`,
            kind: "dead",
            binding: false,
            confidence: "confirmed-by-human",
            evidence: {
              source: `rejection of preference ${pref.id} by ${body.actor}`,
              human: body.actor,
              instrument: "datum preference rejection",
              protocol: "a named human rejected a learned preference; it is never re-promoted",
              events: pref.evidence_events,
              rejected_preference: pref.id,
            },
            asserted_by: `key:${key.label}@${config.org}`,
            supersedes: pref.assertion_id,
            why: body.reason,
            causality: newId("evt"),
          },
          { role: "app", client },
        );
      });

      return reply.send({
        ok: true,
        rejected: true,
        preference: pref.id,
        signature: pref.signature,
        superseded_assertion: pref.assertion_id,
        assertion: rejection?.assertion ?? null,
        note: "rejected. this signature is never re-promoted, however many further events arrive.",
      });
    } catch (err) {
      return sendRejection(deps, request, reply, err, { actor, scope });
    }
  });
}
