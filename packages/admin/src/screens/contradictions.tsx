import {
  CircleAlertIcon,
  ScaleIcon,
  SearchIcon,
  ShieldCheckIcon,
  SplitIcon,
} from "lucide-react";
import { useState } from "react";
import { ConfidenceBadge, KindBadge } from "../components/confidence";
import { ProvenancePanel } from "../components/provenance";
import { request, toApiError, useResource, type ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, objectValue, shortId } from "../lib/format";
import { href, replaceQuery } from "../lib/router";
import type {
  Assertion,
  ContradictionStatus,
  ContradictionWithSides,
} from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { Button, LinkButton } from "../ui/button";
import { Dialog, DialogFooterLeft, DialogFooterRight } from "../ui/dialog";
import { Field, FieldError, FieldHint, Label, Textarea } from "../ui/input";
import { JsonBlock, MicroLabel, Mono, PageHeader } from "../ui/primitives";
import { BlockSkeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/states";
import { Tabs, type TabItem } from "../ui/tabs";
import { useToast } from "../ui/toast";

interface ContradictionsResponse {
  contradictions: ContradictionWithSides[];
}

type StatusFilter = ContradictionStatus | "all";

const TABS: readonly TabItem<StatusFilter>[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "superseded", label: "Superseded" },
  { value: "unreproducible", label: "Unreproducible" },
  { value: "all", label: "All" },
];

export function ContradictionsScreen({ status }: { status: StatusFilter }) {
  const result = useResource<ContradictionsResponse>(
    `/admin/api/contradictions?status=${status}`,
  );
  const [resolving, setResolving] = useState<ContradictionWithSides | null>(null);
  const rows = result.data?.contradictions ?? [];

  return (
    <>
      <PageHeader
        description="Two live rows disagreeing about the same subject and period. Across authority tiers this is allowed on purpose: a human contradicting an instrument lands, both rows stay live, and the disagreement becomes visible without becoming load-bearing."
        title="Contradictions"
      />

      <Tabs
        items={TABS}
        label="Contradiction status"
        onValueChange={(next) =>
          replaceQuery("/contradictions", {
            status: next === "open" ? undefined : next,
          })
        }
        value={status}
      />

      {result.loading ? (
        <BlockSkeleton count={2} height="h-72" />
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load contradictions"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          action={
            status === "open" ? undefined : (
              <Button
                onClick={() => replaceQuery("/contradictions", {})}
                variant="outline"
              >
                Show open queue
              </Button>
            )
          }
          body={
            status === "open"
              ? "Nothing is in dispute. Every subject and predicate in the store has exactly one live answer, or its disagreements have all been resolved."
              : `No contradiction currently has the status "${status}".`
          }
          icon={status === "open" ? ShieldCheckIcon : SearchIcon}
          title={status === "open" ? "Nothing contested" : "No matches"}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {rows.map((row) => (
            <ContradictionCard
              key={row.id}
              onResolve={() => setResolving(row)}
              row={row}
            />
          ))}
        </div>
      )}

      <ResolveDialog
        onClose={() => setResolving(null)}
        onResolved={() => {
          setResolving(null);
          result.reload();
        }}
        target={resolving}
      />
    </>
  );
}

const STATUS_COPY: Record<ContradictionStatus, string> = {
  open: "Unresolved. Both rows are live and every read of them is marked contested.",
  resolved: "Closed by a decision recorded below.",
  superseded: "Closed because one side was superseded by a later assertion.",
  unreproducible:
    "Kept as an unreproducible historical observation. Labelled, never publishable.",
};

function ContradictionCard({
  row,
  onResolve,
}: {
  row: ContradictionWithSides;
  onResolve: () => void;
}) {
  const open = row.status === "open";

  return (
    <div
      className={cn(
        "flex flex-col gap-0 overflow-hidden rounded-xl border-[0.5px] shadow-sm",
        open ? "border-warning/40" : "border-[#E5E5E5]",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 border-b-[0.5px] px-5 py-4",
          open ? "border-b-warning/30 bg-warning/[0.06]" : "border-b-[#E5E5E5] bg-[#FAFAFA]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <Mono className="font-medium text-[15px]">{row.subject}</Mono>
            <span className="text-muted-foreground">·</span>
            <Mono className="font-medium text-[15px]">{row.predicate}</Mono>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CodeBadge variant={open ? "warning" : "outline"}>{row.status}</CodeBadge>
            <Mono className="text-[12px] text-muted-foreground" title={row.scope}>
              {row.scope}
            </Mono>
            <span className="text-muted-foreground text-xs">
              detected {absoluteTime(row.detected_at)}
            </span>
          </div>
        </div>
        {open ? (
          <Button onClick={onResolve} variant="primary">
            <ScaleIcon />
            Resolve
          </Button>
        ) : null}
      </div>

      <p
        className={cn(
          "px-5 py-3 text-sm",
          open ? "text-warning-foreground" : "text-muted-foreground",
        )}
      >
        {STATUS_COPY[row.status]}
      </p>

      {/*
        Both sides are laid out in identical containers with identical type
        scale. Neither column is "the answer" — presenting one as the winner is
        exactly the silent last-write-wins behaviour this store exists to
        refuse.
      */}
      <div className="grid gap-0 border-t-[0.5px] border-t-[#E5E5E5] lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <SideColumn assertion={row.a} label="Side A" />
        <div className="flex items-center justify-center border-t-[0.5px] border-t-[#E5E5E5] bg-[#FAFAFA] px-4 py-3 lg:border-t-0 lg:border-x-[0.5px] lg:border-x-[#E5E5E5] lg:py-0">
          <div className="flex items-center gap-2 lg:flex-col">
            <SplitIcon aria-hidden className="size-4 text-muted-foreground" />
            <span className="datum-microlabel">both live</span>
          </div>
        </div>
        <SideColumn assertion={row.b} label="Side B" />
      </div>

      {row.resolution ? (
        <div className="flex flex-col gap-1.5 border-t-[0.5px] border-t-[#E5E5E5] bg-[#FAFAFA] px-5 py-4">
          <MicroLabel>Resolution</MicroLabel>
          <p className="text-sm leading-relaxed">{row.resolution}</p>
          <p className="text-muted-foreground text-xs">
            {row.resolved_by ? (
              <>
                by <Mono className="text-[12px]">{row.resolved_by}</Mono>
              </>
            ) : null}
            {row.resolved_at ? ` — ${absoluteTime(row.resolved_at)}` : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SideColumn({
  assertion,
  label,
}: {
  assertion: Assertion;
  label: string;
}) {
  const { value, unit } = objectValue(assertion.object);

  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <MicroLabel>{label}</MicroLabel>
        <LinkButton
          href={href(`/assertions/${assertion.id}`)}
          size="sm"
          variant="outline"
        >
          Open row
        </LinkButton>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <ConfidenceBadge confidence={assertion.confidence} />
        <KindBadge kind={assertion.kind} />
        {assertion.contested ? <Badge variant="warning">contested</Badge> : null}
      </div>

      <div className="flex flex-col gap-1">
        <MicroLabel>Value</MicroLabel>
        <p className="flex items-baseline gap-2">
          <Mono className="font-semibold text-xl">{value}</Mono>
          {unit ? <span className="text-muted-foreground text-sm">{unit}</span> : null}
        </p>
      </div>

      {assertion.claim ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Claim</MicroLabel>
          <p className="text-sm leading-relaxed">{assertion.claim}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <MicroLabel>Asserted by</MicroLabel>
          <Mono className="truncate text-[12px]" title={assertion.asserted_by}>
            {assertion.asserted_by}
          </Mono>
        </div>
        <div className="flex flex-col gap-1">
          <MicroLabel>Sequence</MicroLabel>
          <Mono className="text-[12px]">{assertion.asserted_at}</Mono>
        </div>
      </div>

      <div className="border-border border-t pt-4">
        <ProvenancePanel assertion={assertion} />
      </div>

      {assertion.why ? (
        <div className="flex flex-col gap-1">
          <MicroLabel>Why</MicroLabel>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {assertion.why}
          </p>
        </div>
      ) : null}

      <details className="group">
        <summary className="datum-microlabel cursor-pointer list-none rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          Object JSON
        </summary>
        <div className="pt-2">
          <JsonBlock maxHeight="max-h-48" value={assertion.object} />
        </div>
      </details>
    </div>
  );
}

/**
 * The three honest exits from HANDOFF §17. Each names what must already be true
 * before the exit is legitimate, because the resolution record is the only
 * durable account of why a disagreement stopped being open.
 */
interface Exit {
  id: "recovered" | "remeasured" | "unreproducible";
  status: "resolved" | "unreproducible";
  title: string;
  detail: string;
  prerequisite: string;
  template: string;
}

const EXITS: readonly Exit[] = [
  {
    id: "recovered",
    status: "resolved",
    title: "The missing ref was recovered",
    detail:
      "The evidence the human claim pointed at has been found, so a checker can resolve it and the claim becomes promotable to measured.",
    prerequisite:
      "You have the commit or artifact in hand and the verification worker can reach it.",
    template:
      "Recovered the missing ref. Evidence now resolves at: <commit or artifact>. Verification can promote the human claim.",
  },
  {
    id: "remeasured",
    status: "resolved",
    title: "One side was re-measured and superseded",
    detail:
      "A fresh measurement settles the disagreement. Supersede the side that is now wrong through the API; this records why.",
    prerequisite:
      "A new measurement exists and the losing row has been (or is about to be) superseded.",
    template:
      "Re-measured with <instrument/protocol>. Superseded <side A or B, and its id> in favour of the new measurement.",
  },
  {
    id: "unreproducible",
    status: "unreproducible",
    title: "An unreproducible historical observation",
    detail:
      "It happened, nobody can reproduce it, and the record keeps it labelled. It stays in the store and it is never publishable.",
    prerequisite:
      "You have genuinely tried to reproduce it and the evidence is gone for good.",
    template:
      "Unreproducible. Observed once by <who/when>; the evidence is lost and cannot be re-derived. Kept as a labelled historical observation, not publishable.",
  },
];

const EXIT_ICON = {
  recovered: ShieldCheckIcon,
  remeasured: ScaleIcon,
  unreproducible: CircleAlertIcon,
} as const;

function ResolveDialog({
  target,
  onClose,
  onResolved,
}: {
  target: ContradictionWithSides | null;
  onClose: () => void;
  onResolved: () => void;
}) {
  const toast = useToast();
  const [exitId, setExitId] = useState<Exit["id"] | null>(null);
  const [resolution, setResolution] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const exit = EXITS.find((e) => e.id === exitId) ?? null;
  const tooShort = resolution.trim().length < 12;

  function reset() {
    setExitId(null);
    setResolution("");
    setTouched(false);
    setError(null);
  }

  function chooseExit(next: Exit) {
    setExitId(next.id);
    // Only overwrite an untouched note; never clobber typed words.
    setResolution((current) => {
      const isTemplate = EXITS.some((e) => e.template === current);
      return current === "" || isTemplate ? next.template : current;
    });
  }

  async function submit() {
    setTouched(true);
    if (!target || !exit || tooShort || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await request<void>(
        `/admin/api/contradictions/${encodeURIComponent(target.id)}/resolve`,
        {
          method: "POST",
          body: { status: exit.status, resolution: resolution.trim() },
        },
      );
      toast.push({
        tone: "success",
        title: `Marked ${exit.status}`,
        body: `${target.subject} · ${target.predicate} is no longer in the open queue.`,
      });
      reset();
      onResolved();
    } catch (err: unknown) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      description="Pick the exit that is actually true. This note is the only durable account of why the disagreement stopped being open, so write it for whoever reads it in a year."
      dismissable={!submitting}
      footer={
        <>
          <DialogFooterLeft>
            {exit ? (
              <>
                Posts status{" "}
                <CodeBadge variant={exit.status === "resolved" ? "success" : "warning"}>
                  {exit.status}
                </CodeBadge>
              </>
            ) : (
              "Choose an exit to continue."
            )}
          </DialogFooterLeft>
          <DialogFooterRight>
            <Button disabled={submitting} onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={submitting}
              onClick={() => void submit()}
              variant="primary"
            >
              {submitting ? "Recording…" : "Record resolution"}
            </Button>
          </DialogFooterRight>
        </>
      }
      onClose={() => {
        reset();
        onClose();
      }}
      open={target !== null}
      size="lg"
      title="Resolve contradiction"
    >
      {target ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2 rounded-md border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] px-3 py-2.5">
            <Mono className="font-medium">
              {target.subject} · {target.predicate}
            </Mono>
            <span className="text-muted-foreground text-xs">
              <Mono className="text-[12px]">{shortId(target.a_id)}</Mono> (
              {target.a_confidence}) vs{" "}
              <Mono className="text-[12px]">{shortId(target.b_id)}</Mono> (
              {target.b_confidence})
            </span>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="datum-microlabel pb-2">The three honest exits</legend>
            {EXITS.map((option) => {
              const Icon = EXIT_ICON[option.id];
              const selected = exitId === option.id;
              return (
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors",
                    selected
                      ? "border-primary/45 bg-primary/5"
                      : "border-input hover:bg-accent",
                  )}
                  key={option.id}
                >
                  <input
                    checked={selected}
                    className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
                    name="contradiction-exit"
                    onChange={() => chooseExit(option)}
                    type="radio"
                    value={option.id}
                  />
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="flex items-center gap-2 font-medium text-sm">
                      <Icon
                        aria-hidden
                        className={cn(
                          "size-4",
                          selected ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      {option.title}
                    </span>
                    <span className="text-muted-foreground text-sm leading-relaxed">
                      {option.detail}
                    </span>
                    <span className="text-muted-foreground text-xs leading-relaxed">
                      <span className="datum-microlabel">requires</span>{" "}
                      {option.prerequisite}
                    </span>
                  </span>
                </label>
              );
            })}
            {touched && exit === null ? (
              <FieldError>
                Pick the exit that describes what actually happened.
              </FieldError>
            ) : null}
          </fieldset>

          <Field>
            <Label htmlFor="resolution-note">Resolution</Label>
            <Textarea
              aria-invalid={(touched && tooShort) || undefined}
              className="min-h-28"
              id="resolution-note"
              onChange={(e) => setResolution(e.target.value)}
              placeholder="What happened, and what a reader should conclude."
              value={resolution}
            />
            {touched && tooShort ? (
              <FieldError>
                Write at least a sentence. A one-word resolution is worse than an
                open contradiction.
              </FieldError>
            ) : (
              <FieldHint>
                Stored verbatim on the contradiction record and shown on this screen
                forever.
              </FieldHint>
            )}
          </Field>

          {error ? <ErrorState error={error} title="The server refused this" /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
