import { RefreshCwIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import type * as React from "react";
import type { ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { cn, variant as pick } from "../lib/cn";
import { Button } from "./button";
import { CodeBadge } from "./badge";

/**
 * Alert — class strings copied verbatim from runcrate_app
 * `src/components/ui/alert.tsx`: base `relative w-full rounded-lg border p-4
 * [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4
 * [&>svg]:top-4 [&>svg]:text-foreground`, `default` = `bg-background
 * text-foreground`, `destructive` = `border-destructive/50 text-destructive
 * dark:border-destructive [&>svg]:text-destructive`. Title `mb-1 font-medium
 * leading-none tracking-tight`, description `text-sm [&_p]:leading-relaxed`.
 *
 * A `muted` variant is added on `bg-muted/50 border-border/60
 * text-muted-foreground` for the recessed notices this product needs — the
 * banner over a retired row, the note on a check that could not resolve. Those
 * states are not errors and must not be dressed as one, but runcrate's alert
 * only ships neutral and alarm.
 */
const alertBase =
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:top-4 [&>svg]:left-4 [&>svg]:text-foreground";

const alertVariants = {
  default: "bg-background text-foreground",
  destructive:
    "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
  muted:
    "border-border/60 bg-muted/50 text-muted-foreground [&>svg]:text-muted-foreground",
} as const;

export type AlertVariant = keyof typeof alertVariants;

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & { variant?: AlertVariant }) {
  return (
    <div
      className={cn(alertBase, pick(alertVariants, variant, "default"), className)}
      role="alert"
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mb-1 font-medium leading-none tracking-tight", className)}
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
  );
}

/**
 * Empty state, from runcrate's own data screens
 * (`src/pages/dashboard/audit-log.tsx`): `flex flex-col items-center
 * justify-center py-24 text-center`, a `h-10 w-10 text-muted-foreground/50`
 * glyph, a `text-sm text-muted-foreground` headline and a `text-xs
 * text-muted-foreground/50` second line. No illustration slab, no card, no
 * border — the container it sits inside already has one.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center py-24 text-center",
        className,
      )}
    >
      <Icon
        aria-hidden
        className="mb-3 size-10 text-muted-foreground/50"
        strokeWidth={1.5}
      />
      <p className="text-muted-foreground text-sm">{title}</p>
      <p className="mt-1 max-w-md text-muted-foreground/50 text-xs">{body}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * Failed fetch. Shows the store's own `reason` and `message` rather than a
 * generic apology, because on this product the refusal text is the content.
 *
 * runcrate's audit-log spells its error box with raw `red-500/20`,
 * `bg-red-950/20` and `text-red-400` literals — off-palette values that only
 * resolve legibly in dark mode. The token-correct version of the same thing is
 * runcrate's own `alert.tsx` destructive variant, which is what is used here.
 */
export function ErrorState({
  error,
  onRetry,
  title,
  className,
}: {
  error: ApiError;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <Alert className={cn("flex flex-col gap-4", className)} variant="destructive">
      <div className="flex items-start gap-3">
        <TriangleAlertIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-medium leading-none tracking-tight">
            {title ?? "Could not load this"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CodeBadge variant="destructive">{error.reason}</CodeBadge>
            {error.status > 0 ? (
              <CodeBadge variant="outline">HTTP {error.status}</CodeBadge>
            ) : null}
            {error.invariant === undefined ? null : (
              <CodeBadge variant="destructive">
                invariant {error.invariant}
              </CodeBadge>
            )}
            {error.sqlstate ? (
              <CodeBadge variant="outline">sqlstate {error.sqlstate}</CodeBadge>
            ) : null}
          </div>
          <p className="text-foreground text-sm">{error.message}</p>
          {error.says ? (
            <p className="border-destructive/50 border-l-2 pl-3 text-muted-foreground text-sm italic">
              {error.says}
            </p>
          ) : null}
          {error.hint ? (
            <p className="text-muted-foreground text-sm">{error.hint}</p>
          ) : null}
        </div>
      </div>
      {onRetry ? (
        <div>
          <Button onClick={onRetry} size="sm" variant="outline">
            <RefreshCwIcon />
            Try again
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

/** Inline, one-line variant for panels inside a screen that already loaded. */
export function InlineError({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border border-destructive/50 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      <span className="flex min-w-0 items-center gap-2">
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">
          <span className="font-mono text-2xs">{error.reason}</span>
          {" — "}
          {error.message}
        </span>
      </span>
      {onRetry ? (
        <Button className="shrink-0" onClick={onRetry} size="sm" variant="ghost">
          Retry
        </Button>
      ) : null}
    </div>
  );
}
