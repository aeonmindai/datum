import {
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  TargetIcon,
} from "lucide-react";
import { ConfidenceBadge } from "../components/confidence";
import { qs, useResource } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, gateActual } from "../lib/format";
import { href, replaceQuery } from "../lib/router";
import type { GateStatus, Mission, MissionState } from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { Input, Label } from "../ui/input";
import { MicroLabel, Mono, PageHeader } from "../ui/primitives";
import { BlockSkeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/states";

interface MissionsResponse {
  missions: Mission[];
}

const STATE_VARIANT: Record<MissionState, "outline" | "success" | "warning" | "muted"> = {
  proposed: "outline",
  active: "success",
  blocked: "warning",
  closed: "muted",
};

export function MissionsScreen({ scope }: { scope: string }) {
  const result = useResource<MissionsResponse>(
    `/admin/api/missions${qs({ scope })}`,
  );
  const missions = result.data?.missions ?? [];

  return (
    <>
      <PageHeader
        description="A mission is a statement plus the gates that would make it true. Each gate names the evidence class it will accept, which is why a human claim can never make a target look reached."
        title="Missions"
      />

      <div className="grid max-w-md gap-2">
        <Label htmlFor="mission-scope">Scope</Label>
        <Input
          className="font-mono text-[13px]"
          id="mission-scope"
          onChange={(e) =>
            replaceQuery("/missions", { scope: e.target.value || undefined })
          }
          placeholder="All scopes"
          value={scope}
        />
      </div>

      {result.loading ? (
        <BlockSkeleton count={2} height="h-64" />
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load missions"
        />
      ) : missions.length === 0 ? (
        <EmptyState
          body={
            scope
              ? `No mission is declared at ${scope} or below it. Missions are asserted like anything else — through the API, with evidence.`
              : "No mission has been declared yet. A mission turns a statement into gates that can be evaluated against the record, so a target is never 'reached' on vibes."
          }
          icon={TargetIcon}
          title={scope ? "No missions in this scope" : "No missions yet"}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {missions.map((mission) => (
            <MissionCard key={mission.id} mission={mission} />
          ))}
        </div>
      )}
    </>
  );
}

function MissionCard({ mission }: { mission: Mission }) {
  const reached = mission.gates.filter((g) => g.reached === true).length;
  const unknown = mission.gates.filter((g) => g.reached === null).length;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border-[0.5px] border-[#E5E5E5] shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b-[0.5px] border-b-[#E5E5E5] bg-[#FAFAFA] px-5 py-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="max-w-3xl font-semibold text-[15px] leading-snug">
            {mission.statement}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_VARIANT[mission.state]}>{mission.state}</Badge>
            <Mono className="text-[12px] text-muted-foreground" title={mission.scope}>
              {mission.scope}
            </Mono>
            <span className="text-muted-foreground text-xs">
              v{mission.version} · declared by{" "}
              <Mono className="text-[12px]">{mission.asserted_by}</Mono> ·{" "}
              {absoluteTime(mission.created_at)}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="datum-num font-semibold text-sm">
            {reached}/{mission.gates.length}
          </span>
          <span className="datum-microlabel">gates reached</span>
          {unknown > 0 ? (
            <span className="text-warning-foreground text-xs">
              {unknown} with no qualifying evidence
            </span>
          ) : null}
        </div>
      </div>

      {mission.gates.length === 0 ? (
        <p className="px-5 py-6 text-muted-foreground text-sm">
          This mission declares no gates, so nothing about it can be evaluated
          against the record.
        </p>
      ) : (
        <ul className="flex flex-col">
          {mission.gates.map((gate, index) => (
            <GateRow gate={gate} key={`${gate.subject}.${gate.predicate}.${index}`} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Three states, not two.
 *
 * `reached: null` means no assertion of the required confidence class exists —
 * a strictly more useful answer than false, because false says "we looked and
 * the number is wrong" while null says "nothing we would accept has been
 * measured yet". Rendering null as false would quietly turn a missing
 * measurement into a failing one.
 */
function GateRow({ gate }: { gate: GateStatus }) {
  const state = gate.reached === null ? "unknown" : gate.reached ? "reached" : "missed";

  return (
    <li
      className={cn(
        "flex flex-col gap-3 border-b-[0.5px] border-b-[#E5E5E5] px-5 py-4 last:border-b-0 lg:flex-row lg:items-center lg:gap-6",
        state === "unknown" && "bg-warning/[0.05]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Mono className="font-medium">
            {gate.subject}.{gate.predicate}
          </Mono>
          <span className="inline-flex items-baseline gap-1.5 text-sm">
            <Mono className="text-muted-foreground">{gate.op}</Mono>
            <Mono className="font-medium">{String(gate.target)}</Mono>
            {gate.unit ? (
              <span className="text-muted-foreground text-xs">{gate.unit}</span>
            ) : null}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="datum-microlabel">accepts only</span>
            <ConfidenceBadge confidence={gate.requires_confidence} showIcon={false} />
          </span>
          {gate.resolved_scope ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="datum-microlabel">resolved at</span>
              <Mono className="text-[12px] text-muted-foreground">
                {gate.resolved_scope}
              </Mono>
            </span>
          ) : null}
          {gate.evidence ? (
            <a
              className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
              href={href(`/assertions/${gate.evidence}`)}
            >
              evidence row
            </a>
          ) : null}
        </div>

        {gate.note ? (
          <p className="text-muted-foreground text-xs leading-relaxed">{gate.note}</p>
        ) : null}

        {state === "unknown" ? (
          <p className="max-w-2xl text-warning-foreground text-xs leading-relaxed">
            {gate.why_null ??
              `Nothing of confidence class "${gate.requires_confidence}" has been asserted for ${gate.subject}.${gate.predicate}. A claim of another class may exist, but this gate will not read it.`}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-4 lg:justify-end">
        <div className="flex flex-col items-end gap-0.5">
          <MicroLabel>actual</MicroLabel>
          <span className="inline-flex items-baseline gap-1.5">
            <Mono
              className={cn(
                "font-medium",
                state === "unknown" && "text-muted-foreground",
              )}
            >
              {gateActual(gate.actual)}
            </Mono>
            {gate.unit && gate.actual !== null && gate.actual !== undefined ? (
              <span className="text-muted-foreground text-xs">{gate.unit}</span>
            ) : null}
          </span>
          {gate.confidence ? (
            <CodeBadge className="mt-1" variant="outline">
              {gate.confidence}
            </CodeBadge>
          ) : null}
        </div>

        <GatePill state={state} requires={gate.requires_confidence} />
      </div>
    </li>
  );
}

function GatePill({
  state,
  requires,
}: {
  state: "reached" | "missed" | "unknown";
  requires: string;
}) {
  if (state === "reached") {
    return (
      <span className="inline-flex w-[13.5rem] items-center justify-center gap-1.5 rounded-md border-[0.5px] border-success/35 bg-success/12 px-3 py-2 font-medium text-sm text-success-foreground">
        <CircleCheckIcon aria-hidden className="size-4 text-success" />
        reached
      </span>
    );
  }

  if (state === "missed") {
    return (
      <span className="inline-flex w-[13.5rem] items-center justify-center gap-1.5 rounded-md border-[0.5px] border-destructive/30 bg-destructive/8 px-3 py-2 font-medium text-destructive text-sm">
        <CircleXIcon aria-hidden className="size-4" />
        not reached
      </span>
    );
  }

  return (
    <span
      className="inline-flex w-[13.5rem] flex-col items-center gap-0.5 rounded-md border-[0.5px] border-warning/45 border-dashed bg-warning/10 px-3 py-2 text-center"
      title={`This gate evaluates only ${requires} rows. None exists, so the answer is unknown — not false.`}
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-sm text-warning-foreground">
        <CircleHelpIcon aria-hidden className="size-4" />
        no qualifying evidence
      </span>
      <span className="text-[11px] text-warning-foreground/80">
        needs <span className="font-mono">{requires}</span>
      </span>
    </span>
  );
}
