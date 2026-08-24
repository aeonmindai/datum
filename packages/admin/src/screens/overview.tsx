import {
  ArrowRightIcon,
  CircleAlertIcon,
  DatabaseIcon,
  KeyRoundIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  TargetIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { ConfidenceBadge } from "../components/confidence";
import { qs, useResource, type Resource } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, clockTime, relativeTime } from "../lib/format";
import { href } from "../lib/router";
import {
  CONFIDENCE_CLASSES,
  type ApiKey,
  type Confidence,
  type ContradictionWithSides,
  type Mission,
  type Rejection,
} from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { LinkButton } from "../ui/button";
import { MicroLabel, Mono, PageHeader } from "../ui/primitives";
import { Skeleton } from "../ui/skeleton";
import { InlineError } from "../ui/states";

interface Counted {
  total: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Confidence tallies come from the list endpoint's `total`, one call per class. */
function useConfidenceTotals(): Record<Confidence, Resource<Counted>> {
  return {
    measured: useResource<Counted>(
      `/admin/api/assertions${qs({ confidence: "measured", live: "true", limit: 1 })}`,
    ),
    "confirmed-by-human": useResource<Counted>(
      `/admin/api/assertions${qs({
        confidence: "confirmed-by-human",
        live: "true",
        limit: 1,
      })}`,
    ),
    derived: useResource<Counted>(
      `/admin/api/assertions${qs({ confidence: "derived", live: "true", limit: 1 })}`,
    ),
    unverified: useResource<Counted>(
      `/admin/api/assertions${qs({ confidence: "unverified", live: "true", limit: 1 })}`,
    ),
  };
}

export function OverviewScreen({ org }: { org: string }) {
  const live = useResource<Counted>(
    `/admin/api/assertions${qs({ live: "true", limit: 1 })}`,
  );
  const byConfidence = useConfidenceTotals();
  const contradictions = useResource<{ contradictions: ContradictionWithSides[] }>(
    "/admin/api/contradictions?status=open",
  );
  const missions = useResource<{ missions: Mission[] }>("/admin/api/missions");
  const keys = useResource<{ keys: ApiKey[] }>("/admin/api/keys");
  const rejections = useResource<{ rejections: Rejection[] }>(
    "/admin/api/rejections?limit=200",
    { pollMs: 15_000 },
  );

  const openContradictions = contradictions.data?.contradictions ?? [];
  const activeMissions = (missions.data?.missions ?? []).filter(
    (m) => m.state === "active",
  );
  const liveKeys = (keys.data?.keys ?? []).filter((k) => k.revoked_at === null);
  const recentRefusals = (rejections.data?.rejections ?? []).filter((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && Date.now() - at < DAY_MS;
  });

  return (
    <>
      <PageHeader
        description={`Everything ${org} has committed to, and everything it has refused. Nothing here is derived from prose — a human or a verified instrument asserted each row.`}
        title="Overview"
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          error={live.error}
          href={href("/assertions")}
          hint="Superseded rows are excluded, as they are from every default read."
          icon={DatabaseIcon}
          label="Live assertions"
          loading={live.loading}
          onRetry={live.reload}
          value={live.data?.total}
        />
        <StatCard
          error={contradictions.error}
          href={href("/contradictions")}
          hint="Both sides stay live and read back contested until someone resolves it."
          icon={CircleAlertIcon}
          label="Open contradictions"
          loading={contradictions.loading}
          onRetry={contradictions.reload}
          tone={openContradictions.length > 0 ? "warning" : "neutral"}
          value={contradictions.data ? openContradictions.length : undefined}
        />
        <StatCard
          error={rejections.error}
          href={href("/rejections")}
          hint="Writes the database refused in the last 24 hours."
          icon={ScrollTextIcon}
          label="Refusals, 24h"
          loading={rejections.loading}
          onRetry={rejections.reload}
          tone={recentRefusals.length > 0 ? "danger" : "neutral"}
          value={rejections.data ? recentRefusals.length : undefined}
        />
        <StatCard
          error={missions.error}
          href={href("/missions")}
          hint="Missions whose gates are currently being evaluated."
          icon={TargetIcon}
          label="Active missions"
          loading={missions.loading}
          onRetry={missions.reload}
          value={missions.data ? activeMissions.length : undefined}
        />
        <StatCard
          error={keys.error}
          href={href("/keys")}
          hint="Keys that can still authenticate."
          icon={KeyRoundIcon}
          label="Live keys"
          loading={keys.loading}
          onRetry={keys.reload}
          value={keys.data ? liveKeys.length : undefined}
        />
        <div className="flex flex-col gap-4 rounded-xl border-[0.5px] border-[#E5E5E5] bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon aria-hidden className="size-4 text-muted-foreground" />
            <MicroLabel>By confidence class</MicroLabel>
          </div>
          <ul className="flex flex-col gap-2">
            {CONFIDENCE_CLASSES.map((confidence) => {
              const resource = byConfidence[confidence];
              return (
                <li className="flex items-center justify-between gap-3" key={confidence}>
                  <a
                    className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    href={href("/assertions", { confidence })}
                  >
                    <ConfidenceBadge confidence={confidence} showIcon={false} />
                  </a>
                  {resource.loading ? (
                    <Skeleton className="h-4 w-10" />
                  ) : resource.error ? (
                    <span className="text-destructive text-xs">unavailable</span>
                  ) : (
                    <Mono className="font-medium">{resource.data?.total ?? 0}</Mono>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-muted-foreground text-xs leading-relaxed">
            No agent may write <span className="font-mono">measured</span>. The
            verification worker promotes a row only after its evidence resolves, so
            a large <span className="font-mono">unverified</span> count is normal.
          </p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          action={
            <LinkButton href={href("/rejections")} size="sm" variant="outline">
              Full log
              <ArrowRightIcon />
            </LinkButton>
          }
          title="Newest refusals"
        >
          {rejections.loading ? (
            <SkeletonRows />
          ) : rejections.error ? (
            <InlineError error={rejections.error} onRetry={rejections.reload} />
          ) : (rejections.data?.rejections.length ?? 0) === 0 ? (
            <Quiet>
              Nothing has been refused. The invariants have not had to bite yet.
            </Quiet>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {rejections.data?.rejections.slice(0, 5).map((r) => (
                <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0" key={r.id}>
                  <Mono
                    className="mt-0.5 shrink-0 text-[12px] text-muted-foreground"
                    title={absoluteTime(r.at)}
                  >
                    {clockTime(r.at)}
                  </Mono>
                  <div className="flex min-w-0 flex-col gap-1">
                    <CodeBadge variant="danger">{r.reason}</CodeBadge>
                    <p className="truncate text-sm" title={r.message ?? ""}>
                      {r.message ?? "—"}
                    </p>
                    {r.actor ? (
                      <Mono className="truncate text-[11px] text-muted-foreground">
                        {r.actor}
                      </Mono>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          action={
            <LinkButton href={href("/contradictions")} size="sm" variant="outline">
              Queue
              <ArrowRightIcon />
            </LinkButton>
          }
          title="Newest contradictions"
        >
          {contradictions.loading ? (
            <SkeletonRows />
          ) : contradictions.error ? (
            <InlineError
              error={contradictions.error}
              onRetry={contradictions.reload}
            />
          ) : openContradictions.length === 0 ? (
            <Quiet>
              Nothing is contested. Every subject and predicate has one live answer.
            </Quiet>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {openContradictions.slice(0, 3).map((c) => (
                <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" key={c.id}>
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <Mono className="font-medium">{c.subject}</Mono>
                    <span className="text-muted-foreground">·</span>
                    <Mono className="font-medium">{c.predicate}</Mono>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="warning">{c.a_confidence}</Badge>
                    <span className="text-muted-foreground text-xs">vs</span>
                    <Badge variant="warning">{c.b_confidence}</Badge>
                    <span className="text-muted-foreground text-xs">
                      detected {relativeTime(c.detected_at) ?? ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  href: link,
  loading,
  error,
  onRetry,
  tone = "neutral",
}: {
  label: string;
  value: number | undefined;
  hint: string;
  icon: typeof DatabaseIcon;
  href: string;
  loading: boolean;
  error: Resource<Counted>["error"];
  onRetry: () => void;
  tone?: "neutral" | "warning" | "danger";
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border-[0.5px] bg-card p-5 shadow-sm",
        tone === "warning" && "border-warning/40",
        tone === "danger" && "border-destructive/35",
        tone === "neutral" && "border-[#E5E5E5]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          <MicroLabel>{label}</MicroLabel>
        </div>
        <a
          aria-label={`Open ${label}`}
          className="rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          href={link}
        >
          <ArrowRightIcon aria-hidden className="size-4" />
        </a>
      </div>

      {loading ? (
        <Skeleton className="h-9 w-20" />
      ) : error ? (
        <InlineError error={error} onRetry={onRetry} />
      ) : (
        <p
          className={cn(
            "datum-num font-semibold text-3xl leading-none",
            tone === "warning" && "text-warning-foreground",
            tone === "danger" && "text-destructive",
          )}
        >
          {value ?? 0}
        </p>
      )}

      <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>
    </div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl border-[0.5px] border-[#E5E5E5] bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold leading-none">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <Skeleton className="h-10 w-full" key={i} />
      ))}
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] px-4 py-6 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}
