import { RefreshCwIcon, TriangleAlertIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { Button } from "./button";
import { CodeBadge } from "./badge";

/**
 * echos_app's canonical empty state
 * (`components/accounts/accounts-empty-state.tsx`): container
 * `flex flex-1 flex-col items-center justify-center gap-4 rounded-lg
 * border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] p-6`, an 84px visual, an
 * `text-xl font-semibold` title and a centred `text-sm text-muted-foreground`
 * body. echos uses an illustration at that size; there is no illustration set
 * here, so the 84px slot holds a Lucide glyph in a muted rounded square.
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
        "flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] p-6 py-14",
        className,
      )}
    >
      <div className="flex size-[84px] shrink-0 items-center justify-center rounded-2xl border-[0.5px] border-[#E5E5E5] bg-white">
        <Icon aria-hidden className="size-9 text-muted-foreground/70" strokeWidth={1.5} />
      </div>
      <div className="flex max-w-md flex-col items-center gap-2">
        <p className="font-semibold text-foreground text-xl">{title}</p>
        <p className="text-center text-muted-foreground text-sm">{body}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * Failed fetch. Shows the store's own `reason` and `message` rather than a
 * generic apology, because on this product the refusal text is the content.
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
    <div
      className={cn(
        "flex flex-col gap-4 rounded-lg border-[0.5px] border-destructive/40 bg-destructive/5 p-6",
        className,
      )}
      role="alert"
    >
      <div className="flex items-start gap-3">
        <TriangleAlertIcon
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <p className="font-semibold text-destructive">
            {title ?? "Could not load this"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CodeBadge variant="danger">{error.reason}</CodeBadge>
            {error.status > 0 ? (
              <CodeBadge variant="outline">HTTP {error.status}</CodeBadge>
            ) : null}
            {error.invariant === undefined ? null : (
              <CodeBadge variant="danger">invariant {error.invariant}</CodeBadge>
            )}
            {error.sqlstate ? (
              <CodeBadge variant="outline">sqlstate {error.sqlstate}</CodeBadge>
            ) : null}
          </div>
          <p className="text-foreground/80 text-sm">{error.message}</p>
          {error.says ? (
            <p className="border-destructive/30 border-l-2 pl-3 text-muted-foreground text-sm italic">
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
    </div>
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
      className="flex items-center justify-between gap-3 rounded-md border-[0.5px] border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
      role="alert"
    >
      <span className="flex min-w-0 items-center gap-2">
        <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        <span className="truncate text-destructive">
          <span className="font-mono text-[11px]">{error.reason}</span>
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
