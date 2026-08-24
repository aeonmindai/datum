import type * as React from "react";
import { cn, variant as pick } from "../lib/cn";

/**
 * Base string from echos_app `components/ui/badge.tsx`, verbatim minus the
 * `[a&]` anchor-hover selectors it needs for asChild links.
 *
 * echos ships four variants (default / secondary / destructive / outline).
 * Datum needs semantic confidence colours, so `success`, `info`, `warning` and
 * `dead` are added on echos's own `--success` / `--warning` tokens plus the two
 * new tokens documented in index.css. Every added variant follows echos's
 * tinted-surface-with-matching-border shape rather than a solid fill, because a
 * table row can carry three badges and four solid fills would shout.
 */
const badgeBase =
  "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden";

const badgeVariants = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-white",
  outline: "text-foreground",
  muted: "border-transparent bg-muted text-muted-foreground",
  success: "border-success/30 bg-success/12 text-success-foreground",
  info: "border-info/30 bg-info/12 text-info-foreground",
  warning: "border-warning/40 bg-warning/15 text-warning-foreground",
  purple: "border-primary/30 bg-primary/10 text-primary",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  dead: "border-dead-foreground/25 bg-dead text-dead-foreground",
} as const;

export type BadgeVariant = keyof typeof badgeVariants;

export interface BadgeProps extends React.ComponentProps<"span"> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeBase, pick(badgeVariants, variant, "default"), className)}
      data-slot="badge"
      {...props}
    />
  );
}

/** Monospace code badge — reasons, sqlstates, permission names. */
export function CodeBadge({
  className,
  variant,
  ...props
}: BadgeProps) {
  return (
    <Badge
      className={cn("font-mono text-[11px] tracking-tight", className)}
      variant={variant ?? "outline"}
      {...props}
    />
  );
}
