import {
  BanIcon,
  CircleAlertIcon,
  FlaskConicalIcon,
  GitBranchIcon,
  ShieldCheckIcon,
  SkullIcon,
  UserCheckIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import type { Assertion, Confidence, Kind } from "../lib/types";
import { Badge, type BadgeVariant } from "../ui/badge";

/**
 * Confidence is the product's central idea, so it gets the only fully
 * semantic colour mapping in the app:
 *
 *   measured           success  — earned by the verification worker
 *   confirmed-by-human primary  — echos's purple, the human-authority colour
 *   derived            info     — computed from other rows
 *   unverified         warning  — normal and expected, never an error
 *
 * `unverified` is amber rather than red on purpose. No agent may write
 * `measured`, so every honest agent write starts here.
 */
const CONFIDENCE_STYLE: Record<
  Confidence,
  { variant: BadgeVariant; icon: typeof ShieldCheckIcon; title: string }
> = {
  measured: {
    variant: "success",
    icon: ShieldCheckIcon,
    title: "Measured — promoted by the verification worker after its evidence resolved",
  },
  "confirmed-by-human": {
    variant: "purple",
    icon: UserCheckIcon,
    title: "Confirmed by a named human — testimony, not an instrument reading",
  },
  derived: {
    variant: "info",
    icon: GitBranchIcon,
    title: "Derived from other assertions",
  },
  unverified: {
    variant: "warning",
    icon: FlaskConicalIcon,
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
    <Badge className={className} title={style.title} variant={style.variant}>
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
  untried: "muted",
  failed: "danger",
  dead: "dead",
};

export function KindBadge({ kind }: { kind: Kind }) {
  return (
    <Badge className="font-mono text-[11px]" variant={KIND_VARIANT[kind]}>
      {kind === "dead" ? <SkullIcon aria-hidden /> : null}
      {kind}
    </Badge>
  );
}

/**
 * A superseded row is dead, not annotated. No strikethrough: strikethrough
 * reads as "edited" and this store never edits. The treatment is recession —
 * muted surface, dropped opacity, a heavy muted left border and an explicit
 * badge — so a retired row is unmissable at a glance in a long table.
 */
export function isRetired(a: Assertion): boolean {
  return a.superseded_by !== null || a.kind === "dead";
}

export function assertionRowClass(a: Assertion): string {
  const retired = isRetired(a);
  return cn(
    "[&>td:first-child]:border-l-[3px]",
    retired
      ? "bg-dead/70 text-dead-foreground opacity-75 hover:bg-dead hover:opacity-90 [&>td:first-child]:border-l-dead-foreground/45"
      : a.contested
        ? "bg-warning/[0.06] [&>td:first-child]:border-l-warning"
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
          title="Superseded. This row is retired and is excluded from every default read."
          variant="dead"
        >
          <BanIcon aria-hidden />
          superseded
        </Badge>
      ) : null}
      {assertion.contested ? (
        <Badge
          title="One side of an open contradiction. Both sides stay live; the store never silently picks one."
          variant="warning"
        >
          <CircleAlertIcon aria-hidden />
          contested
        </Badge>
      ) : null}
      {assertion.inputs_unresolvable ? (
        <Badge
          title="A derived row whose inputs are no longer resolvable in this chain, so its value cannot be recomputed."
          variant="danger"
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
