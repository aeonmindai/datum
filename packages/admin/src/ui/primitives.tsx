import { CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { prettyJson } from "../lib/format";
import { cn } from "../lib/cn";
import { Button } from "./button";

/**
 * Monospace token. echos aliases --font-mono to Outfit and never renders code,
 * so this treatment is Datum's own: every id, hash, commit, scope path and
 * sequence number goes through it, with tabular figures so a polling table does
 * not jitter.
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
      className={cn("datum-num font-mono text-[13px] tracking-tight", className)}
      title={title}
    >
      {children}
    </span>
  );
}

/** Uppercase tracked micro-label for field names in detail panels. */
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
  variant?: "outline" | "ghost" | "primary";
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
        "datum-scroll overflow-auto rounded-md border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] p-3 font-mono text-[12px] leading-relaxed",
        maxHeight,
        className,
      )}
    >
      {prettyJson(value)}
    </pre>
  );
}

/** Page header: title, one-line explanation, actions on the right. */
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
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="font-semibold text-foreground text-xl tracking-tight">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-muted-foreground text-sm">{description}</p>
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
  tone?: "muted" | "danger" | "primary";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border-[0.5px] px-2.5 py-1.5",
        tone === "danger" && "border-destructive/30 bg-destructive/5",
        tone === "primary" && "border-primary/25 bg-primary/5",
        tone === "muted" && "border-[#E5E5E5] bg-[#FAFAFA]",
      )}
    >
      <span className="font-mono text-[11px] text-muted-foreground">{label}</span>
      <span className="datum-num font-semibold text-sm">{value}</span>
    </div>
  );
}
