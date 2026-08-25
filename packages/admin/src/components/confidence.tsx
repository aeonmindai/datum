import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  GitBranchIcon,
  SkullIcon,
  UserCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { Assertion, Confidence, Kind } from "../lib/types";
import {
  Badge,
  BADGE_ALARM,
  BADGE_PENDING,
  BADGE_RETIRED,
  type BadgeVariant,
} from "../ui/badge";

/**
 * Confidence is the product's central idea, and it is the one place where the
 * palette and the product pull in opposite directions.
 *
 * runcrate's palette is monochrome: pure neutral greys, one accent (the blue
 * focus ring, which is never used to classify anything) and one alarm colour
 * (destructive red). There is no green, no amber and no blue to spend on a
 * four-class ramp, and inventing three would not be a restyle.
 *
 * So the ranking is carried by fill weight, border style, icon and monospace
 * labelling instead of hue — which is arguably the better encoding, because it
 * survives greyscale, colour blindness and a printed screenshot:
 *
 *   measured            solid, inverted   check      the only class a gate reads
 *   confirmed-by-human  grey fill         person     testimony, not an instrument
 *   derived             outline           branch     computed from other rows
 *   unverified          dashed outline    clock      normal, and not an error
 *
 * Weight decreases exactly as authority decreases, so a column of these reads
 * as a ranking at a glance. `unverified` is dashed rather than red on purpose:
 * no agent may write `measured`, so every honest agent write starts here.
 *
 * Red is reserved. It appears only on a refuted verification, a rejected write
 * and `kind: dead` — three states that are genuinely bad — plus, as an edge and
 * text tint rather than a fill, on a contested row and a derived row whose
 * inputs no longer resolve.
 */
const CONFIDENCE_STYLE: Record<
  Confidence,
  { variant: BadgeVariant; className?: string; icon: LucideIcon; title: string }
> = {
  measured: {
    variant: "default",
    icon: CircleCheckIcon,
    title:
      "Measured — promoted by the verification worker after its evidence resolved. The only class a gate will read.",
  },
  "confirmed-by-human": {
    variant: "secondary",
    icon: UserCheckIcon,
    title: "Confirmed by a named human — testimony, not an instrument reading",
  },
  derived: {
    variant: "outline",
    icon: GitBranchIcon,
    title: "Derived from other assertions",
  },
  unverified: {
    variant: "outline",
    className: BADGE_PENDING,
    icon: ClockIcon,
    title:
      "Unverified — the normal state of a fresh agent write. Confidence is earned, never asserted",
  },
};

export function ConfidenceBadge({
  confidence,
  className,
  showIcon = true,
}: {
  confidence: Confidence;
  className?: string;
  showIcon?: boolean;
}) {
  const style = CONFIDENCE_STYLE[confidence];
  const Icon = style.icon;
  return (
    <Badge
      className={cn("font-mono", style.className, className)}
      title={style.title}
      variant={style.variant}
    >
      {showIcon ? <Icon aria-hidden /> : null}
      {confidence}
    </Badge>
  );
}

const KIND_VARIANT: Record<Kind, BadgeVariant> = {
  measured: "outline",
  target: "outline",
  rule: "outline",
  constraint: "outline",
  state: "outline",
  untried: "secondary",
  failed: "destructive",
  dead: "destructive",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <Badge className="font-mono text-2xs" variant={KIND_VARIANT[kind]}>
      {kind === "dead" ? <SkullIcon aria-hidden /> : null}
      {kind}
    </Badge>
  );
}

/**
 * A superseded row is dead, not annotated. No strikethrough: strikethrough
 * reads as "edited" and this store never edits. The treatment is recession —
 * `bg-muted/50`, muted text, dropped opacity and a `border-l-2 border-border`
 * spine — so a retired row is unmissable in a long table without spending a
 * colour on it.
 *
 * A contested row gets the same spine in `border-destructive/50`, because
 * unlike a retired row a contested fact is an actual problem: two live
 * assertions disagree and the store refuses to pick one for you.
 */
export function isRetired(a: Assertion): boolean {
  return a.superseded_by !== null || a.kind === "dead";
}

export function assertionRowClass(a: Assertion): string {
  const retired = isRetired(a);
  return cn(
    "[&>td:first-child]:border-l-2",
    retired
      ? "bg-muted/50 text-muted-foreground opacity-75 hover:bg-muted hover:opacity-100 [&>td:first-child]:border-l-border"
      : a.contested
        ? "[&>td:first-child]:border-l-destructive/50"
        : "[&>td:first-child]:border-l-transparent",
  );
}

/**
 * The lifecycle flags that change how much a row can be trusted. Rendered
 * together so no screen forgets one.
 */
export function LifecycleBadges({
  assertion,
  className,
}: {
  assertion: Assertion;
  className?: string;
}) {
  const flags = [
    assertion.superseded_by !== null,
    assertion.contested === true,
    assertion.inputs_unresolvable === true,
    assertion.binding,
  ];
  if (!flags.some(Boolean)) return null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {assertion.superseded_by !== null ? (
        <Badge
          className={BADGE_RETIRED}
          title="Superseded. This row is retired and is excluded from every default read."
          variant="secondary"
        >
          <BanIcon aria-hidden />
          superseded
        </Badge>
      ) : null}
      {assertion.contested ? (
        <Badge
          className={BADGE_ALARM}
          title="One side of an open contradiction. Both sides stay live; the store never silently picks one."
          variant="outline"
        >
          <CircleAlertIcon aria-hidden />
          contested
        </Badge>
      ) : null}
      {assertion.inputs_unresolvable ? (
        <Badge
          className={BADGE_ALARM}
          title="A derived row whose inputs are no longer resolvable in this chain, so its value cannot be recomputed."
          variant="outline"
        >
          derived: inputs unresolvable
        </Badge>
      ) : null}
      {assertion.binding ? (
        <Badge title="Binding: agents must honour this." variant="outline">
          binding
        </Badge>
      ) : null}
    </span>
  );
}
