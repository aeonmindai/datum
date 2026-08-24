import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleDotIcon,
  ClockIcon,
  FileWarningIcon,
  HistoryIcon,
  RewindIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SkullIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  ConfidenceBadge,
  KindBadge,
  LifecycleBadges,
} from "../components/confidence";
import { ProvenancePanel } from "../components/provenance";
import { qs, useResource } from "../lib/api";
import { cn } from "../lib/cn";
import {
  absoluteTime,
  isVerificationActor,
  objectValue,
  shortId,
} from "../lib/format";
import { href } from "../lib/router";
import type {
  Assertion,
  AssertionDetail,
  TakeResult,
  VerificationRecord,
} from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { Button, LinkButton } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input, Label } from "../ui/input";
import {
  CopyButton,
  FieldRow,
  JsonBlock,
  MicroLabel,
  Mono,
} from "../ui/primitives";
import { BlockSkeleton, Skeleton } from "../ui/skeleton";
import { ErrorState, InlineError } from "../ui/states";

export function AssertionDetailScreen({
  id,
  sequence,
}: {
  id: string;
  sequence: number;
}) {
  const detail = useResource<AssertionDetail>(
    `/admin/api/assertions/${encodeURIComponent(id)}`,
  );

  if (detail.loading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-80" />
        <BlockSkeleton count={2} height="h-56" />
      </div>
    );
  }

  if (detail.error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <ErrorState
          error={detail.error}
          onRetry={detail.reload}
          title="Could not load this assertion"
        />
      </div>
    );
  }

  const data = detail.data;
  if (!data) return null;

  const a = data.assertion;
  const { value, unit } = objectValue(a.object);
  const retired = a.superseded_by !== null;

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-semibold text-xl tracking-tight">
            <Mono className="text-[19px]">{a.subject}</Mono>
            <span className="text-muted-foreground">·</span>
            <Mono className="text-[19px]">{a.predicate}</Mono>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <ConfidenceBadge confidence={a.confidence} />
            <KindBadge kind={a.kind} />
            <LifecycleBadges assertion={a} />
            <Mono className="text-[12px] text-muted-foreground" title={a.scope}>
              {a.scope}
            </Mono>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CopyButton label="Copy id" value={a.id} />
        </div>
      </div>

      {retired ? (
        <div
          className="flex items-start gap-3 rounded-lg border-[0.5px] border-dead-foreground/30 bg-dead px-4 py-3"
          role="status"
        >
          <SkullIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-dead-foreground"
          />
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <p className="font-medium text-dead-foreground">
              This row is retired and is excluded from every default read.
            </p>
            <p className="text-dead-foreground/85">
              It was superseded at sequence{" "}
              <Mono className="text-[13px]">{a.superseded_at ?? "—"}</Mono> by{" "}
              <a
                className="underline underline-offset-2"
                href={href(`/assertions/${a.superseded_by}`)}
              >
                <Mono className="text-[13px]">{shortId(a.superseded_by ?? "", 12)}</Mono>
              </a>
              . It is kept because rewriting history would destroy the ability to
              reproduce what was believed before.
            </p>
          </div>
        </div>
      ) : null}

      {data.verification ? <VerificationBanner record={data.verification} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>The claim</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <MicroLabel>Value</MicroLabel>
                <p className="flex items-baseline gap-2">
                  <Mono className="font-semibold text-2xl">{value}</Mono>
                  {unit ? (
                    <span className="text-muted-foreground text-sm">{unit}</span>
                  ) : null}
                </p>
              </div>

              {a.claim ? (
                <FieldRow label="Claim">
                  <p className="leading-relaxed">{a.claim}</p>
                </FieldRow>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <FieldRow label="Asserted by">
                  <Mono className="break-all">{a.asserted_by}</Mono>
                </FieldRow>
                <FieldRow label="Sequence">
                  <Mono title="Write sequence number, not a timestamp">
                    {a.asserted_at}
                  </Mono>
                </FieldRow>
                <FieldRow label="Recorded at">
                  <span className="text-muted-foreground">
                    {absoluteTime(a.created_at)}
                  </span>
                </FieldRow>
                <FieldRow label="Valid">
                  <span className="text-muted-foreground">
                    {a.valid_from}
                    {a.valid_to ? ` → ${a.valid_to}` : " → open"}
                  </span>
                </FieldRow>
                <FieldRow label="Hash">
                  <Mono className="break-all text-muted-foreground text-[12px]">
                    {a.hash}
                  </Mono>
                </FieldRow>
                <FieldRow label="Id">
                  <Mono className="break-all text-muted-foreground text-[12px]">
                    {a.id}
                  </Mono>
                </FieldRow>
              </div>

              {a.why || a.reopen_if || a.causality || a.derived_from.length > 0 ? (
                <div className="grid gap-4 border-border border-t pt-5 sm:grid-cols-2">
                  {a.why ? (
                    <FieldRow className="sm:col-span-2" label="Why">
                      <p className="leading-relaxed">{a.why}</p>
                    </FieldRow>
                  ) : null}
                  {a.reopen_if ? (
                    <FieldRow className="sm:col-span-2" label="Reopen if">
                      <p className="leading-relaxed">{a.reopen_if}</p>
                    </FieldRow>
                  ) : null}
                  {a.causality ? (
                    <FieldRow label="Causality">
                      <Mono className="break-all text-muted-foreground">
                        {a.causality}
                      </Mono>
                    </FieldRow>
                  ) : null}
                  {a.derived_from.length > 0 ? (
                    <FieldRow label="Derived from">
                      <ul className="flex flex-col gap-1">
                        {a.derived_from.map((ref) => (
                          <li key={ref}>
                            <a
                              className="underline underline-offset-2"
                              href={href(`/assertions/${ref}`)}
                            >
                              <Mono className="text-[12px]">{shortId(ref, 12)}</Mono>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </FieldRow>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col gap-2 border-border border-t pt-5">
                <MicroLabel>Object</MicroLabel>
                <JsonBlock value={a.object} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
            </CardHeader>
            <CardContent>
              <ProvenancePanel assertion={a} verification={data.verification} />
            </CardContent>
          </Card>

          {data.contradictions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CircleAlertIcon aria-hidden className="size-4 text-warning" />
                  Contradictions
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {data.contradictions.map((c) => (
                  <a
                    className="flex items-center justify-between gap-3 rounded-md border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] px-3 py-2.5 transition-colors hover:bg-accent"
                    href={href("/contradictions", { status: c.status })}
                    key={c.id}
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <Mono className="truncate">
                        {c.subject} · {c.predicate}
                      </Mono>
                      <span className="text-muted-foreground text-xs">
                        {c.a_confidence} vs {c.b_confidence}
                      </span>
                    </span>
                    <CodeBadge
                      variant={c.status === "open" ? "warning" : "outline"}
                    >
                      {c.status}
                    </CodeBadge>
                  </a>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <LineageCard assertion={a} lineage={data.lineage} />
          <AsOfCard assertion={a} sequence={sequence} />
        </div>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <LinkButton
      className="w-fit px-0"
      href={href("/assertions")}
      size="sm"
      variant="link"
    >
      <ArrowLeftIcon />
      All assertions
    </LinkButton>
  );
}

function VerificationBanner({ record }: { record: VerificationRecord }) {
  if (record.outcome === "refuted") {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border-[0.5px] border-destructive/45 bg-destructive/8 px-4 py-3"
        role="alert"
      >
        <ShieldAlertIcon
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="font-semibold text-destructive">
            A checker refuted this claim
          </p>
          <p className="text-foreground/85 text-sm leading-relaxed">
            <Mono>{record.checker}</Mono> looked for the evidence this row cites and
            found it does not hold. The row is kept — nothing here is deleted — but
            it must not be treated as true, and it can never be promoted to
            measured on this evidence.
          </p>
          <p className="text-muted-foreground text-sm">
            Checked {absoluteTime(record.checked_at)}
          </p>
          {record.detail ? <JsonBlock maxHeight="max-h-40" value={record.detail} /> : null}
        </div>
      </div>
    );
  }

  if (record.outcome === "unresolvable") {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border-[0.5px] border-warning/45 bg-warning/10 px-4 py-3"
        role="status"
      >
        <FileWarningIcon
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-warning-foreground"
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="font-semibold text-warning-foreground">
            The cited reference could not be resolved
          </p>
          <p className="text-warning-foreground/85 text-sm leading-relaxed">
            <Mono>{record.checker}</Mono> could not find the commit this row points
            at. Recover the ref and the claim becomes promotable; until then it
            stays where it is.
          </p>
          <p className="text-muted-foreground text-sm">
            Checked {absoluteTime(record.checked_at)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-start gap-3 rounded-lg border-[0.5px] border-success/40 bg-success/8 px-4 py-3"
      role="status"
    >
      <ShieldCheckIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-success-foreground">
          Verification confirmed this claim
        </p>
        <p className="text-success-foreground/85 text-sm">
          <Mono>{record.checker}</Mono> resolved the cited commit and confirmed it is
          contained where the claim says it is — {absoluteTime(record.checked_at)}.
        </p>
      </div>
    </div>
  );
}

/**
 * Supersession chain, oldest at the top. Ordering is deliberate: reading down
 * the column is reading forward in time, and the live head is the last thing
 * you see rather than something to hunt for.
 */
function LineageCard({
  assertion,
  lineage,
}: {
  assertion: Assertion;
  lineage: Assertion[];
}) {
  const chain = lineage.length > 0 ? lineage : [assertion];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HistoryIcon aria-hidden className="size-4 text-muted-foreground" />
          Supersession chain
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative flex flex-col gap-0">
          {chain.map((row, index) => {
            const previous = index > 0 ? chain[index - 1] : undefined;
            const isHead = row.superseded_by === null;
            const isCurrent = row.id === assertion.id;
            const { value, unit } = objectValue(row.object);
            const promoted =
              previous !== undefined &&
              isVerificationActor(row.asserted_by) &&
              row.confidence === "measured";

            return (
              <li className="relative flex gap-3 pb-5 last:pb-0" key={row.id}>
                <div className="flex flex-col items-center">
                  <span
                    className={cn(
                      "z-10 mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border-2 bg-background",
                      isHead
                        ? "border-success"
                        : "border-dead-foreground/40",
                    )}
                  >
                    {isHead ? (
                      <span className="size-1.5 rounded-full bg-success" />
                    ) : null}
                  </span>
                  {index < chain.length - 1 ? (
                    <span className="-mb-5 w-px flex-1 bg-border" />
                  ) : null}
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {previous ? (
                    <p
                      className={cn(
                        "flex items-center gap-1.5 text-[11px]",
                        promoted ? "text-success" : "text-muted-foreground",
                      )}
                    >
                      {promoted ? (
                        <>
                          <ShieldCheckIcon aria-hidden className="size-3" />
                          promoted by verification
                        </>
                      ) : (
                        <>
                          <RewindIcon aria-hidden className="size-3" />
                          superseded the row above
                        </>
                      )}
                    </p>
                  ) : null}

                  <div
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border-[0.5px] p-3 transition-colors",
                      isCurrent
                        ? "border-primary/40 bg-primary/5"
                        : isHead
                          ? "border-[#E5E5E5] bg-background"
                          : "border-dead-foreground/25 bg-dead/60 opacity-80",
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ConfidenceBadge confidence={row.confidence} showIcon={false} />
                      {isHead ? (
                        <Badge variant="success">
                          <CircleDotIcon aria-hidden />
                          live head
                        </Badge>
                      ) : (
                        <Badge variant="dead">superseded</Badge>
                      )}
                      {isCurrent ? <Badge variant="purple">viewing</Badge> : null}
                    </div>

                    <p className="flex items-baseline gap-1.5">
                      <Mono className="font-medium">{value}</Mono>
                      {unit ? (
                        <span className="text-muted-foreground text-xs">{unit}</span>
                      ) : null}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
                      <span className="inline-flex items-center gap-1">
                        <span className="datum-microlabel">seq</span>
                        <Mono className="text-[12px]">{row.asserted_at}</Mono>
                      </span>
                      <Mono className="truncate text-[12px]" title={row.asserted_by}>
                        {row.asserted_by}
                      </Mono>
                    </div>

                    {row.why ? (
                      <p className="border-border border-l-2 pl-2.5 text-muted-foreground text-xs leading-relaxed">
                        {row.why}
                      </p>
                    ) : null}

                    {isCurrent ? null : (
                      <a
                        className="w-fit text-[11px] underline underline-offset-2 hover:text-foreground"
                        href={href(`/assertions/${row.id}`)}
                      >
                        open this row
                      </a>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/**
 * The as-of control. Answers "what did we believe at write N?" by replaying
 * resolution against the sequence rather than reading the current head.
 *
 * Sequence-based rather than date-based on purpose: `asserted_at` is a sequence
 * number, so a sequence is the only cut point that is exact. Two writes in the
 * same millisecond are still ordered.
 */
function AsOfCard({
  assertion,
  sequence,
}: {
  assertion: Assertion;
  sequence: number;
}) {
  const writtenAt = Number.parseInt(assertion.asserted_at, 10);
  const max = Math.max(sequence, Number.isFinite(writtenAt) ? writtenAt : 1, 1);
  const [asOf, setAsOf] = useState(max);
  const [debounced, setDebounced] = useState(max);
  /**
   * The number field holds raw text so an operator can clear it and retype.
   * Clamping on every keystroke made it impossible to type a smaller number:
   * emptying the field produced NaN and silently kept the old sequence. The
   * value is parsed and clamped on commit — blur or Enter — instead.
   */
  const [draft, setDraft] = useState(String(max));

  const commitDraft = () => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), max)
      : asOf;
    setAsOf(next);
    setDraft(String(next));
  };

  const jumpTo = (next: number) => {
    const clamped = Math.min(Math.max(next, 1), max);
    setAsOf(clamped);
    setDraft(String(clamped));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(asOf), 200);
    return () => window.clearTimeout(timer);
  }, [asOf]);

  const path = useMemo(
    () =>
      `/admin/api/take${qs({
        scope: assertion.scope,
        subject: assertion.subject,
        predicate: assertion.predicate,
        as_of: debounced,
      })}`,
    [assertion.scope, assertion.subject, assertion.predicate, debounced],
  );

  const take = useResource<TakeResult>(path);
  const believed = take.data?.assertions ?? [];
  const atHead = asOf >= max;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClockIcon aria-hidden className="size-4 text-muted-foreground" />
          What did we believe?
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-muted-foreground text-sm leading-relaxed">
          Rewind resolution to any write in this instance&apos;s history. The answer
          below is what <Mono className="text-[12px]">{assertion.subject}</Mono> ·{" "}
          <Mono className="text-[12px]">{assertion.predicate}</Mono> resolved to at
          that point — not the current head.
        </p>

        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            <div className="grid flex-1 gap-2">
              <Label htmlFor="as-of-seq">As of sequence</Label>
              <Input
                aria-describedby="as-of-hint"
                className="font-mono"
                id="as-of-seq"
                inputMode="numeric"
                max={max}
                min={1}
                onBlur={commitDraft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitDraft();
                  }
                }}
                type="number"
                value={draft}
              />
            </div>
            <Button
              className="shrink-0"
              disabled={atHead}
              onClick={() => jumpTo(max)}
              variant="outline"
            >
              Now
            </Button>
          </div>

          <input
            aria-label="As-of sequence"
            aria-valuetext={`sequence ${asOf} of ${max}`}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            max={max}
            min={1}
            onChange={(e) => jumpTo(Number.parseInt(e.target.value, 10))}
            step={1}
            type="range"
            value={asOf}
          />

          <div className="flex items-center justify-between text-muted-foreground text-xs">
            <span className="datum-num">1</span>
            <button
              className="rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => {
                if (Number.isFinite(writtenAt)) jumpTo(writtenAt);
              }}
              type="button"
            >
              jump to this write ({assertion.asserted_at})
            </button>
            <span className="datum-num">{max}</span>
          </div>
          <p className="text-muted-foreground text-xs" id="as-of-hint">
            Type a sequence and press Enter, or drag the slider.
          </p>
        </div>

        <div className="flex flex-col gap-3 border-border border-t pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <MicroLabel>
              Believed at sequence {debounced}
              {atHead ? " (now)" : ""}
            </MicroLabel>
            {take.data ? (
              <span className="flex items-center gap-1.5">
                <CodeBadge variant={take.data.mode === "isolated" ? "warning" : "outline"}>
                  {take.data.mode}
                </CodeBadge>
                <span
                  className="text-muted-foreground text-xs"
                  title={take.data.chain.join(" → ")}
                >
                  {take.data.chain.length} scope
                  {take.data.chain.length === 1 ? "" : "s"} in chain
                </span>
              </span>
            ) : null}
          </div>

          {take.loading ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : take.error ? (
            <InlineError error={take.error} onRetry={take.reload} />
          ) : believed.length === 0 ? (
            <div className="flex flex-col gap-1.5 rounded-lg border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] px-3 py-4 text-center">
              <p className="font-medium text-sm">Nothing was believed yet</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                At sequence {debounced} this subject and predicate had no live
                assertion in the resolution chain.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {believed.map((row) => {
                const { value, unit } = objectValue(row.object);
                const isThis = row.id === assertion.id;
                return (
                  <li
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border-[0.5px] p-3",
                      isThis
                        ? "border-primary/40 bg-primary/5"
                        : "border-[#E5E5E5] bg-background",
                    )}
                    key={row.id}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ConfidenceBadge confidence={row.confidence} showIcon={false} />
                      <KindBadge kind={row.kind} />
                      {isThis ? <Badge variant="purple">this row</Badge> : null}
                      {row.contested ? <Badge variant="warning">contested</Badge> : null}
                    </div>
                    <p className="flex items-baseline gap-1.5">
                      <Mono className="font-medium">{value}</Mono>
                      {unit ? (
                        <span className="text-muted-foreground text-xs">{unit}</span>
                      ) : null}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 text-muted-foreground text-xs">
                      <Mono className="text-[12px]" title={row.scope}>
                        {row.scope}
                      </Mono>
                      <span className="inline-flex items-center gap-1">
                        <span className="datum-microlabel">seq</span>
                        <Mono className="text-[12px]">{row.asserted_at}</Mono>
                      </span>
                    </div>
                    {isThis ? null : (
                      <a
                        className="w-fit text-[11px] underline underline-offset-2 hover:text-foreground"
                        href={href(`/assertions/${row.id}`)}
                      >
                        open
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
