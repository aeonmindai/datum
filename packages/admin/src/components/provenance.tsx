import {
  CircleSlashIcon,
  FileWarningIcon,
  GitCommitHorizontalIcon,
  InfoIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldQuestionMarkIcon,
} from "lucide-react";
import { useSession } from "../app/session";
import { shortCommit } from "../lib/format";
import { cn } from "../lib/cn";
import type {
  Assertion,
  VerificationCapability,
  VerificationRecord,
} from "../lib/types";
import { Badge } from "../ui/badge";
import { HoverCard } from "../ui/hover-card";
import { MicroLabel, Mono } from "../ui/primitives";

/**
 * Where a claim stands with the verification worker, stated honestly.
 *
 * Three distinct answers, and conflating any two of them would misrepresent the
 * store:
 *   - promoted: this row IS `measured`, so a checker resolved its commit.
 *   - awaiting verification: the row can still be promoted.
 *   - not available on this instance: no checker is configured, so nothing here
 *     will ever be promoted. That is an operator fact, not a pending queue.
 */
function verificationStanding(
  a: Assertion,
  capability: VerificationCapability | null,
): { tone: "ok" | "pending" | "off" | "n/a"; label: string; detail: string } {
  if (a.confidence === "measured") {
    return {
      tone: "ok",
      label: "verification promoted this claim",
      detail:
        "A checker resolved evidence.commit and confirmed it is contained where the claim says it is.",
    };
  }
  if (a.confidence === "derived") {
    return {
      tone: "n/a",
      label: "derived — not a verification target",
      detail:
        "Derived rows are computed from other assertions rather than measured, so the worker does not promote them.",
    };
  }
  if (a.confidence === "confirmed-by-human") {
    return {
      tone: "pending",
      label: "human testimony, not promoted",
      detail:
        "A named human stands behind this. It can only become measured if the missing ref is recovered and a checker confirms it.",
    };
  }
  if (capability && !capability.configured) {
    return {
      tone: "off",
      label: "verification not configured on this instance",
      detail:
        "No checker is wired up, so nothing on this deployment can be promoted to measured. Configure one to make unverified rows promotable.",
    };
  }
  return {
    tone: "pending",
    label: "awaiting verification",
    detail:
      "Unverified is the normal state of a fresh agent write. The worker promotes it to measured once evidence.commit resolves and is contained where claimed.",
  };
}

const STANDING_ICON = {
  ok: ShieldCheckIcon,
  pending: ShieldQuestionMarkIcon,
  off: CircleSlashIcon,
  "n/a": InfoIcon,
} as const;

const STANDING_CLASS = {
  ok: "text-success",
  pending: "text-warning",
  off: "text-muted-foreground",
  "n/a": "text-info",
} as const;

function VerificationOutcomeBadge({ record }: { record: VerificationRecord }) {
  if (record.outcome === "refuted") {
    return (
      <Badge
        title="A checker looked for this evidence and found it does not hold. Treat this claim as false."
        variant="destructive"
      >
        <ShieldAlertIcon aria-hidden />
        refuted
      </Badge>
    );
  }
  if (record.outcome === "unresolvable") {
    return (
      <Badge
        title="A checker could not resolve the referenced commit at all — it may have been lost or never pushed."
        variant="warning"
      >
        <FileWarningIcon aria-hidden />
        unresolvable
      </Badge>
    );
  }
  return (
    <Badge variant="success">
      <ShieldCheckIcon aria-hidden />
      confirmed
    </Badge>
  );
}

/** The popover body. Also reused as a static block on the detail screen. */
export function ProvenancePanel({
  assertion,
  verification,
}: {
  assertion: Assertion;
  verification?: VerificationRecord | null;
}) {
  const { session } = useSession();
  const capability =
    session.status === "authenticated" ? session.me.verification : null;
  const standing = verificationStanding(assertion, capability);
  const Icon = STANDING_ICON[standing.tone];
  const e = assertion.evidence ?? { source: "" };
  const commit = shortCommit(e.commit);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <MicroLabel>Source</MicroLabel>
        <p className="break-words text-sm">{e.source || "—"}</p>
      </div>

      {e.repo || commit ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Repo / commit</MicroLabel>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {e.repo ? <Mono>{e.repo}</Mono> : null}
            {commit ? (
              <span className="inline-flex items-center gap-1">
                <GitCommitHorizontalIcon
                  aria-hidden
                  className="size-3.5 text-muted-foreground"
                />
                <Mono title={e.commit}>{commit}</Mono>
              </span>
            ) : (
              <span className="text-muted-foreground text-sm">no commit</span>
            )}
          </p>
        </div>
      ) : null}

      {e.contained_in && e.contained_in.length > 0 ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Contained in</MicroLabel>
          <div className="flex flex-wrap gap-1">
            {e.contained_in.map((ref) => (
              <Badge className="font-mono text-[11px]" key={ref} variant="outline">
                {ref}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {e.instrument || e.protocol ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <MicroLabel>Instrument</MicroLabel>
            <p className="break-words text-sm">{e.instrument ?? "—"}</p>
          </div>
          <div className="flex flex-col gap-1">
            <MicroLabel>Protocol</MicroLabel>
            <p className="break-words text-sm">{e.protocol ?? "—"}</p>
          </div>
        </div>
      ) : null}

      {e.human ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Human</MicroLabel>
          <p className="text-sm">{e.human}</p>
        </div>
      ) : null}

      {e.artifacts && e.artifacts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Artifacts</MicroLabel>
          <ul className="flex flex-col gap-0.5">
            {e.artifacts.map((a) => (
              <li className="truncate" key={a}>
                <Mono className="text-muted-foreground" title={a}>
                  {a}
                </Mono>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5 border-border border-t pt-3">
        <MicroLabel>Verification</MicroLabel>
        {verification ? (
          <div className="flex flex-col gap-1.5">
            <VerificationOutcomeBadge record={verification} />
            <p className="text-muted-foreground text-sm">
              Checked by <Mono>{verification.checker}</Mono>
            </p>
          </div>
        ) : (
          <>
            <p
              className={cn(
                "flex items-start gap-2 font-medium text-sm",
                STANDING_CLASS[standing.tone],
              )}
            >
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {standing.label}
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {standing.detail}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The evidence table cell. Shows the shortest useful summary — source kind plus
 * the abbreviated commit — and opens the full provenance on hover or focus.
 */
export function EvidenceCell({ assertion }: { assertion: Assertion }) {
  const e = assertion.evidence ?? { source: "" };
  const commit = shortCommit(e.commit);
  const summary = commit ?? e.instrument ?? e.human ?? e.source ?? "—";

  return (
    <HoverCard
      trigger={
        <span className="inline-flex max-w-[15rem] items-center gap-1.5">
          {commit ? (
            <GitCommitHorizontalIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          ) : null}
          <span
            className={cn(
              "truncate border-muted-foreground/40 border-b border-dashed text-sm",
              commit ? "font-mono text-[13px]" : "text-muted-foreground",
            )}
          >
            {summary}
          </span>
        </span>
      }
      width={420}
    >
      <ProvenancePanel assertion={assertion} />
    </HoverCard>
  );
}
