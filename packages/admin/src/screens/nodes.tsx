import { ServerIcon } from "lucide-react";
import { useResource } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, ageMs, relativeTime } from "../lib/format";
import type { RegistryNode } from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { JsonBlock, Mono, PageHeader } from "../ui/primitives";
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

interface NodesResponse {
  nodes: RegistryNode[];
}

/** Anything quieter than this is stale rather than merely idle. */
const STALE_MS = 15 * 60 * 1000;

export function NodesScreen() {
  const result = useResource<NodesResponse>("/admin/api/nodes", { pollMs: 15_000 });
  const nodes = result.data?.nodes ?? [];

  return (
    <>
      <PageHeader
        description="Who is connected to this instance, at what scope, and when it was last heard from. Heartbeats are recorded but not enforced in v0, so a stale node is a hint rather than a verdict."
        title="Nodes"
      />

      {result.loading ? (
        <TableShell>
          <TableSkeleton
            columns={["9rem", "6rem", "12rem", "8rem", "7rem", "7rem", "4rem"]}
          />
        </TableShell>
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load the node registry"
        />
      ) : nodes.length === 0 ? (
        <EmptyState
          body="No agent, worker or repo has registered itself. Nodes appear when a client calls the registry — for a repo, that is what `datum link` does."
          icon={ServerIcon}
          title="Nothing registered"
        />
      ) : (
        <TableShell>
          <Table>
            <TableHeader sticky>
              <TableRow className="hover:bg-transparent">
                <TableHead>label</TableHead>
                <TableHead>kind</TableHead>
                <TableHead>scope</TableHead>
                <TableHead>role</TableHead>
                <TableHead>last seen</TableHead>
                <TableHead>heartbeat</TableHead>
                <TableHead>registered</TableHead>
                <TableHead>meta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((node) => (
                <NodeRow key={node.id} row={node} />
              ))}
            </TableBody>
          </Table>
        </TableShell>
      )}
    </>
  );
}

function NodeRow({ row }: { row: RegistryNode }) {
  const seenAge = ageMs(row.last_seen ?? row.heartbeat_at);
  const stale = seenAge === null || seenAge > STALE_MS;
  const hasMeta = row.meta !== null && Object.keys(row.meta).length > 0;

  return (
    <TableRow
      className={cn(
        "[&>td:first-child]:border-l-[3px]",
        stale
          ? "[&>td:first-child]:border-l-dead-foreground/35"
          : "[&>td:first-child]:border-l-success/60",
      )}
    >
      <TableCell className="max-w-[16rem]">
        <div className="flex flex-col gap-0.5">
          <span className="truncate font-medium">{row.label ?? row.id}</span>
          <Mono className="truncate text-[11px] text-muted-foreground" title={row.id}>
            {row.id}
          </Mono>
        </div>
      </TableCell>
      <TableCell>
        <CodeBadge variant="outline">{row.kind}</CodeBadge>
      </TableCell>
      <TableCell className="max-w-[18rem]">
        <Mono className="truncate text-muted-foreground" title={row.scope}>
          {row.scope}
        </Mono>
      </TableCell>
      <TableCell>
        {row.role ? (
          <span className="text-sm">{row.role}</span>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.last_seen === null ? (
          <span className="text-muted-foreground text-sm">never</span>
        ) : (
          <span
            className="inline-flex items-center gap-2 text-sm"
            title={absoluteTime(row.last_seen)}
          >
            {relativeTime(row.last_seen)}
            {stale ? <Badge variant="muted">stale</Badge> : null}
          </span>
        )}
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground text-sm" title={absoluteTime(row.heartbeat_at)}>
          {relativeTime(row.heartbeat_at) ?? "—"}
        </span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground text-sm" title={absoluteTime(row.created_at)}>
          {relativeTime(row.created_at) ?? "—"}
        </span>
      </TableCell>
      <TableCell className="max-w-[20rem] whitespace-normal">
        {hasMeta ? (
          <details>
            <summary className="datum-microlabel cursor-pointer list-none rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              show
            </summary>
            <div className="pt-2">
              <JsonBlock maxHeight="max-h-40" value={row.meta} />
            </div>
          </details>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
