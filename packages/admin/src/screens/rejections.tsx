import { ChevronRightIcon, ShieldCheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useResource } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, clockTime, relativeTime } from "../lib/format";
import type { Rejection } from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { JsonBlock, MicroLabel, Mono, PageHeader, StatChip } from "../ui/primitives";
import { TableSkeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "../ui/table";

interface RejectionsResponse {
  rejections: Rejection[];
}

const POLL_MS = 5000;
const LIMIT = 200;

export function RejectionsScreen() {
  // Polls only while the tab is visible — a background tab should not keep a
  // self-hosted single-machine instance busy.
  const result = useResource<RejectionsResponse>(
    `/admin/api/rejections?limit=${LIMIT}`,
    { pollMs: POLL_MS },
  );
  const rows = result.data?.rejections ?? [];

  const byReason = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  return (
    <>
      <PageHeader
        actions={
          <span className="flex items-center gap-2 text-muted-foreground text-xs">
            <span
              className={cn(
                "size-1.5 rounded-full",
                result.refreshing ? "bg-primary" : "bg-success",
              )}
            />
            live · every {POLL_MS / 1000}s
          </span>
        }
        description="What the store refused, and why. Every line here is an invariant biting: the database rejected the write, so nothing partially-true was ever recorded."
        title="Rejected writes"
      />

      {byReason.length > 0 ? (
        <div className="flex flex-col gap-2">
          <MicroLabel>By reason</MicroLabel>
          <div className="flex flex-wrap gap-2">
            <StatChip label="total" tone="primary" value={rows.length} />
            {byReason.map(([reason, count]) => (
              <StatChip key={reason} label={reason} tone="danger" value={count} />
            ))}
          </div>
        </div>
      ) : null}

      {result.loading ? (
        <TableShell>
          <TableSkeleton
            columns={["5rem", "10rem", "4rem", "9rem", "8rem", "16rem", "3rem"]}
            rows={8}
          />
        </TableShell>
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load the rejection log"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          body="Nothing has been refused. Either no agent has tried to write something the invariants forbid, or nothing has written at all yet — mint a key and watch this fill up the first time evidence is missing."
          icon={ShieldCheckIcon}
          title="Nothing refused yet"
        />
      ) : (
        <TableShell>
          <Table>
            <TableHeader sticky>
              <TableRow className="hover:bg-transparent">
                <TableHead>time</TableHead>
                <TableHead>reason · invariant</TableHead>
                <TableHead>actor · route</TableHead>
                <TableHead>target</TableHead>
                <TableHead>message</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <RejectionRow key={row.id} row={row} />
              ))}
            </TableBody>
          </Table>
        </TableShell>
      )}
    </>
  );
}

/** Invariant number, when the reason carries one. */
function invariantOf(row: Rejection): number | null {
  const raw = row.detail?.invariant;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function RejectionRow({ row }: { row: Rejection }) {
  const [open, setOpen] = useState(false);
  const invariant = invariantOf(row);
  const hasDetail = row.detail !== null && Object.keys(row.detail).length > 0;
  const target = [row.scope, row.subject, row.predicate].filter(Boolean);

  return (
    <>
      <TableRow
        className={cn(
          "[&>td:first-child]:border-l-[3px] [&>td:first-child]:border-l-destructive/45",
          open && "bg-muted/40",
        )}
      >
        <TableCell>
          <span className="flex flex-col leading-tight" title={absoluteTime(row.at)}>
            <Mono className="text-[12px]">{clockTime(row.at)}</Mono>
            <span className="text-[11px] text-muted-foreground">
              {relativeTime(row.at) ?? ""}
            </span>
          </span>
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-1.5">
            <CodeBadge variant="danger">{row.reason}</CodeBadge>
            {invariant === null ? null : (
              <Badge
                className="datum-num"
                title={`Invariant ${invariant}`}
                variant="danger"
              >
                {invariant}
              </Badge>
            )}
          </span>
        </TableCell>
        <TableCell className="max-w-[13rem]">
          <div className="flex flex-col gap-0.5">
            <Mono className="truncate text-[12px]" title={row.actor ?? ""}>
              {row.actor ?? "—"}
            </Mono>
            <Mono
              className="truncate text-[11px] text-muted-foreground"
              title={row.route ?? ""}
            >
              {row.route ?? "—"}
            </Mono>
          </div>
        </TableCell>
        <TableCell className="max-w-[11rem]">
          {target.length === 0 ? (
            <span className="text-muted-foreground text-sm">—</span>
          ) : (
            <Mono className="block truncate text-[12px]" title={target.join(" · ")}>
              {target.join(" · ")}
            </Mono>
          )}
        </TableCell>
        <TableCell className="max-w-[19rem]">
          <span className="block truncate text-sm" title={row.message ?? ""}>
            {row.message ?? "—"}
          </span>
        </TableCell>
        <TableCell className="text-right">
          {hasDetail || row.sqlstate ? (
            <button
              aria-expanded={open}
              className="inline-flex items-center gap-1 rounded-sm text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => setOpen((v) => !v)}
              type="button"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  open && "rotate-90",
                )}
              />
              detail
            </button>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell
            className="whitespace-normal border-r-0 bg-muted/30 p-0"
            colSpan={6}
          >
            <div className="flex flex-col gap-3 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <CodeBadge variant="danger">{row.reason}</CodeBadge>
                {row.sqlstate ? (
                  <CodeBadge variant="outline">sqlstate {row.sqlstate}</CodeBadge>
                ) : null}
                <span className="text-muted-foreground text-xs">
                  {absoluteTime(row.at)}
                </span>
              </div>
              {row.message ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {row.message}
                </p>
              ) : null}
              {hasDetail ? <JsonBlock value={row.detail} /> : null}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
