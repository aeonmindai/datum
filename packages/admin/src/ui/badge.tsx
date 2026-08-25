import type * as React from "react";
import { cn, variant as pick } from "../lib/cn";

/**
 * Base string and all four variants copied verbatim from runcrate_app
 * `src/components/ui/badge.tsx`, minus the `[a&]:hover:` selectors it needs for
 * Radix `asChild` anchors. runcrate ships exactly these four and no more, and
 * so does this panel: the palette has one accent (the blue focus ring) and one
 * alarm colour (destructive red), so a five-colour semantic ramp is not
 * available. Meaning is carried by fill weight, border style, icon and
 * monospace labelling instead — see DESIGN_NOTES.md.
 */
const badgeBase =
  "inline-flex items-center justify-center rounded-lg border px-2.5 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none transition-colors overflow-hidden";

const badgeVariants = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
  outline: "text-foreground border-border/60",
} as const;

export type BadgeVariant = keyof typeof badgeVariants;

/**
 * The three composed treatments this product needs on top of the four variants.
 * They are class strings rather than new variants because they are states, not
 * new colours — each one is an `outline` or `secondary` badge with its border
 * style or text weight adjusted. Named here so the eight screens that use them
 * cannot drift apart.
 */

/** Not-yet-known, and that is fine: dashed edge, recessed text. `unverified`,
 *  an unresolvable check, a gate with no qualifying evidence. */
export const BADGE_PENDING = "border-dashed text-muted-foreground";

/** A real problem that is not yet a refusal: red edge and red text on an
 *  otherwise plain badge. Loud enough to find in a long table, quiet enough
 *  that a solid `destructive` still outranks it. */
export const BADGE_ALARM = "border-destructive/50 text-destructive";

/** Retired. Kept in the record, excluded from every default read. */
export const BADGE_RETIRED = "text-muted-foreground";

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

/**
 * Monospace code badge — reasons, sqlstates, permission names, kinds. Anything
 * that is a literal server token rather than prose goes through this, so an
 * operator can tell a value they can grep for from a label we wrote.
 */
export function CodeBadge({ className, variant, ...props }: BadgeProps) {
  return (
    <Badge
      className={cn("font-mono text-2xs tracking-tight", className)}
      variant={variant ?? "outline"}
      {...props}
    />
  );
}
