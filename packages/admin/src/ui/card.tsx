import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Class strings copied verbatim from runcrate_app `src/components/ui/card.tsx`.
 * The `@container/card-header` query variant is dropped (nothing here needs
 * it); everything else — `rounded-2xl border border-border/60 py-6 gap-6`,
 * `px-6` on every sub-slot, the `has-data-[slot=card-action]` two-column
 * header, `leading-none font-semibold` on the title — is runcrate's.
 *
 * There is deliberately no shadow. In runcrate the page background and the card
 * surface are the same colour: a card is defined by its outline, so it reads as
 * cut into the page rather than floating on it. Adding elevation here would be
 * the single fastest way to make this look like a copy instead of the original.
 */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-6 rounded-2xl border border-border/60 bg-card py-6 text-card-foreground",
        className,
      )}
      data-slot="card"
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className,
      )}
      data-slot="card-header"
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("font-semibold leading-none", className)}
      data-slot="card-title"
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="card-description"
      {...props}
    />
  );
}

export function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      data-slot="card-action"
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("px-6", className)} data-slot="card-content" {...props} />
  );
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      data-slot="card-footer"
      {...props}
    />
  );
}
