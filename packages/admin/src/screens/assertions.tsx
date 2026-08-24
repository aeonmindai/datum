import {
  ArrowRightIcon,
  DatabaseIcon,
  FunnelIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  assertionRowClass,
  ConfidenceBadge,
  KindBadge,
  LifecycleBadges,
} from "../components/confidence";
import { EvidenceCell } from "../components/provenance";
import { qs, useResource } from "../lib/api";
import { objectValue, shortId } from "../lib/format";
import { href, replaceQuery } from "../lib/router";
import {
  CONFIDENCE_CLASSES,
  KINDS,
  type Assertion,
  type Confidence,
  type Kind,
} from "../lib/types";
import { Button, LinkButton } from "../ui/button";
import { FilterSelect } from "../ui/select";
import { Input, Label } from "../ui/input";
import { Mono, PageHeader } from "../ui/primitives";
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

interface AssertionsResponse {
  rows: Assertion[];
  total: number;
}

export interface AssertionFilters {
  scope: string;
  subject: string;
  predicate: string;
  kind: string;
  confidence: string;
  live: boolean;
  q: string;
  offset: number;
}

const PAGE_SIZE = 50;

export function readFilters(query: URLSearchParams): AssertionFilters {
  return {
    scope: query.get("scope") ?? "",
    subject: query.get("subject") ?? "",
    predicate: query.get("predicate") ?? "",
    kind: query.get("kind") ?? "",
    confidence: query.get("confidence") ?? "",
    // Live-only defaults ON: a default read of an append-only store must not
    // put retired rows in front of you. Turning it off is the deliberate act.
    live: (query.get("live") ?? "true") !== "false",
    q: query.get("q") ?? "",
    offset: Number.parseInt(query.get("offset") ?? "0", 10) || 0,
  };
}

function toQuery(f: AssertionFilters): Record<string, string | undefined> {
  return {
    scope: f.scope || undefined,
    subject: f.subject || undefined,
    predicate: f.predicate || undefined,
    kind: f.kind || undefined,
    confidence: f.confidence || undefined,
    live: f.live ? undefined : "false",
    q: f.q || undefined,
    offset: f.offset > 0 ? String(f.offset) : undefined,
  };
}

export function AssertionsScreen({ filters }: { filters: AssertionFilters }) {
  // Text inputs are local so typing does not refetch on every keystroke; the
  // hash (and therefore the request) updates on submit or on a 350ms idle.
  const [draft, setDraft] = useState(filters);

  useEffect(() => setDraft(filters), [filters]);

  useEffect(() => {
    const changed =
      draft.q !== filters.q ||
      draft.scope !== filters.scope ||
      draft.subject !== filters.subject ||
      draft.predicate !== filters.predicate;
    if (!changed) return;
    const timer = window.setTimeout(() => {
      replaceQuery("/assertions", toQuery({ ...draft, offset: 0 }));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft, filters]);

  const path = useMemo(
    () =>
      `/admin/api/assertions${qs({
        scope: filters.scope,
        subject: filters.subject,
        predicate: filters.predicate,
        kind: filters.kind,
        confidence: filters.confidence,
        live: filters.live ? "true" : "false",
        q: filters.q,
        limit: PAGE_SIZE,
        offset: filters.offset,
      })}`,
    [filters],
  );

  const result = useResource<AssertionsResponse>(path);
  const rows = result.data?.rows ?? [];
  const total = result.data?.total ?? 0;
  const filtered =
    filters.scope !== "" ||
    filters.subject !== "" ||
    filters.predicate !== "" ||
    filters.kind !== "" ||
    filters.confidence !== "" ||
    filters.q !== "";

  function apply(next: Partial<AssertionFilters>) {
    replaceQuery("/assertions", toQuery({ ...filters, offset: 0, ...next }));
  }

  return (
    <>
      <PageHeader
        actions={
          filtered ? (
            <Button onClick={() => replaceQuery("/assertions", {})} variant="outline">
              Clear filters
            </Button>
          ) : undefined
        }
        description="Every claim in the store, newest first. Confidence is earned: no agent may write measured, so unverified is the normal state of a fresh write."
        title="Assertions"
      />

      <div className="flex flex-col gap-3 rounded-xl border border-edge bg-surface p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <FunnelIcon aria-hidden className="size-3.5" />
          <span className="datum-microlabel">Filters</span>
        </div>

        <div className="grid gap-3 lg:grid-cols-4">
          <div className="grid gap-2 lg:col-span-2">
            <Label htmlFor="f-q">Search</Label>
            <Input
              id="f-q"
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              placeholder="Free text across subject, predicate, claim and object"
              suffix={
                <SearchIcon aria-hidden className="mr-2 size-4 text-muted-foreground" />
              }
              value={draft.q}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-scope">Scope</Label>
            <Input
              className="font-mono text-sm"
              id="f-scope"
              onChange={(e) => setDraft({ ...draft, scope: e.target.value })}
              placeholder="org/acme/project/arc"
              value={draft.scope}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-subject">Subject</Label>
            <Input
              className="font-mono text-sm"
              id="f-subject"
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="bake"
              value={draft.subject}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-predicate">Predicate</Label>
            <Input
              className="font-mono text-sm"
              id="f-predicate"
              onChange={(e) => setDraft({ ...draft, predicate: e.target.value })}
              placeholder="duration_minutes"
              value={draft.predicate}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-kind">Kind</Label>
            <FilterSelect
              anyLabel="Any kind"
              id="f-kind"
              onChange={(e) => apply({ kind: e.target.value as Kind | "" })}
              options={KINDS}
              value={filters.kind}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-confidence">Confidence</Label>
            <FilterSelect
              anyLabel="Any confidence"
              id="f-confidence"
              onChange={(e) => apply({ confidence: e.target.value as Confidence | "" })}
              options={CONFIDENCE_CLASSES}
              value={filters.confidence}
            />
          </div>
          <div className="flex items-end">
            <label className="flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-xl border border-input bg-input-bg px-3.5 text-sm transition-colors hover:bg-accent">
              <input
                checked={filters.live}
                className="size-4 accent-[hsl(var(--primary))]"
                onChange={(e) => apply({ live: e.target.checked })}
                type="checkbox"
              />
              <span className="font-medium">Live only</span>
              <span className="ml-auto text-muted-foreground text-xs">
                hide retired
              </span>
            </label>
          </div>
        </div>
      </div>

      {result.loading ? (
        <TableShell>
          <TableSkeleton
            columns={[
              "9rem",
              "6rem",
              "8rem",
              "4rem",
              "7rem",
              "7rem",
              "3rem",
            ]}
            rows={8}
          />
        </TableShell>
      ) : result.error ? (
        <ErrorState
          error={result.error}
          onRetry={result.reload}
          title="Could not load assertions"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          action={
            filtered ? (
              <Button onClick={() => replaceQuery("/assertions", {})} variant="outline">
                Clear filters
              </Button>
            ) : undefined
          }
          body={
            filtered
              ? "No assertion matches these filters. Widen the scope, drop the confidence class, or turn off live-only to include retired rows."
              : "Nothing has been asserted yet. Mint a key with the assert permission and have an agent write its first claim — with evidence, which the database requires."
          }
          icon={DatabaseIcon}
          title={filtered ? "No matches" : "The store is empty"}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <TableShell>
            <Table>
              <TableHeader sticky>
                <TableRow className="hover:bg-transparent">
                  <TableHead>confidence · kind</TableHead>
                  <TableHead>subject</TableHead>
                  <TableHead>predicate</TableHead>
                  <TableHead className="text-right">value</TableHead>
                  <TableHead>asserted by · seq</TableHead>
                  <TableHead>evidence</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <AssertionRow key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </TableShell>

          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              Showing{" "}
              <span className="datum-num font-medium text-foreground">
                {filters.offset + 1}–{filters.offset + rows.length}
              </span>{" "}
              of <span className="datum-num font-medium text-foreground">{total}</span>
              {filters.live ? " live" : ""} assertion{total === 1 ? "" : "s"}
            </p>
            <div className="flex items-center gap-2">
              <Button
                disabled={filters.offset === 0}
                onClick={() =>
                  replaceQuery(
                    "/assertions",
                    toQuery({
                      ...filters,
                      offset: Math.max(0, filters.offset - PAGE_SIZE),
                    }),
                  )
                }
                size="sm"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={filters.offset + rows.length >= total}
                onClick={() =>
                  replaceQuery(
                    "/assertions",
                    toQuery({ ...filters, offset: filters.offset + PAGE_SIZE }),
                  )
                }
                size="sm"
                variant="outline"
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AssertionRow({ row }: { row: Assertion }) {
  const { value, unit } = objectValue(row.object);
  const retired = row.superseded_by !== null;

  return (
    <TableRow className={assertionRowClass(row)}>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <ConfidenceBadge confidence={row.confidence} />
          <KindBadge kind={row.kind} />
        </div>
      </TableCell>
      <TableCell className="max-w-[9rem]">
        <div className="flex flex-col gap-0.5">
          <Mono className="truncate font-medium" title={row.subject}>
            {row.subject}
          </Mono>
          <Mono className="truncate text-2xs text-muted-foreground" title={row.scope}>
            {row.scope}
          </Mono>
        </div>
      </TableCell>
      <TableCell className="max-w-[11rem]">
        <div className="flex flex-col items-start gap-1">
          <Mono className="max-w-full truncate" title={row.predicate}>
            {row.predicate}
          </Mono>
          <LifecycleBadges assertion={row} />
          {retired && row.superseded_by ? (
            <a
              className="inline-flex w-fit items-center gap-1 text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              href={href(`/assertions/${row.superseded_by}`)}
            >
              superseded by
              <Mono className="text-2xs">{shortId(row.superseded_by)}</Mono>
              <ArrowRightIcon aria-hidden className="size-3" />
            </a>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-[8rem] text-right">
        <span className="inline-flex max-w-full items-baseline justify-end gap-1">
          <Mono className="truncate font-medium" title={value}>
            {value}
          </Mono>
          {unit ? (
            <span className="shrink-0 text-muted-foreground text-xs">{unit}</span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="max-w-[9rem]">
        <div className="flex flex-col gap-0.5">
          <Mono className="truncate text-muted-foreground" title={row.asserted_by}>
            {row.asserted_by}
          </Mono>
          <Mono
            className="text-2xs text-muted-foreground"
            title="Write sequence number — not a timestamp"
          >
            seq {row.asserted_at}
          </Mono>
        </div>
      </TableCell>
      <TableCell>
        <EvidenceCell assertion={row} />
      </TableCell>
      <TableCell className="text-right">
        <LinkButton href={href(`/assertions/${row.id}`)} size="sm" variant="outline">
          Open
        </LinkButton>
      </TableCell>
    </TableRow>
  );
}
