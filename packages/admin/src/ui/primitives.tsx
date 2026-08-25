import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { prettyJson } from "../lib/format";
import { cn } from "../lib/cn";
import { Button } from "./button";

/**
 * Monospace token. runcrate sets `font-mono` to JetBrains Mono and reaches for
 * it on every literal value in its data tables — ip addresses, resource names,
 * balances, timestamps — always with `tabular-nums` so a polling table does not
 * jitter. Every id, hash, commit, scope path and sequence number here goes
 * through this.
 */
export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={cn("datum-num font-mono text-sm tracking-tight", className)}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Uppercase tracked micro-label. Same treatment runcrate uses for the column
 * headers of its data tables — see `.datum-microlabel` in index.css.
 */
export function MicroLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("datum-microlabel", className)}>{children}</div>;
}

/** Micro-label above a value. The detail-panel unit used across five screens. */
export function FieldRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <MicroLabel>{label}</MicroLabel>
      <div className="min-w-0 text-sm">{children}</div>
    </div>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
  variant = "outline",
  className,
}: {
  value: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(done, () => undefined);
      return;
    }
    // No clipboard API (http origin, older embedded browser): select the text
    // in a throwaway field so the operator can still copy it manually.
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    document.body.removeChild(field);
    done();
  }, [value]);

  return (
    <Button className={className} onClick={copy} size={size} variant={variant}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Pretty-printed JSON in a recessed panel. Used for objects and detail blobs. */
export function JsonBlock({
  value,
  className,
  maxHeight = "max-h-72",
}: {
  value: unknown;
  className?: string;
  maxHeight?: string;
}) {
  return (
    <pre
      className={cn(
        "overflow-auto rounded-lg border border-edge bg-muted/50 p-3 font-mono text-xs leading-relaxed",
        maxHeight,
        className,
      )}
      data-slot="scroll-container"
    >
      {prettyJson(value)}
    </pre>
  );
}

/**
 * Page header. runcrate's screens all open the same way
 * (`src/pages/dashboard/audit-log.tsx`, `api-keys.tsx`): a `flex justify-between
 * items-center mb-6` row with `h1.text-xl.font-medium`, a
 * `text-muted-foreground text-sm mt-1` line under it, and actions in a
 * `flex gap-2` on the right. `font-medium` rather than semibold, and no
 * letter-spacing override — the body rule's -0.011em already does that work.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <h1 className="font-medium text-xl">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-muted-foreground text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Small counted chip used for the rejection reason histogram. */
export function StatChip({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number | string;
  tone?: "muted" | "destructive";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-1.5",
        tone === "destructive"
          ? "border-destructive/50 text-destructive"
          : "border-edge bg-muted/50",
      )}
    >
      <span className="font-mono text-2xs text-muted-foreground">{label}</span>
      <span className="datum-num font-semibold text-sm">{value}</span>
    </div>
  );
}
