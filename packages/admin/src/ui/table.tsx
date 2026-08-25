import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Two runcrate sources are combined here, because runcrate itself uses two
 * table treatments and every table in this panel is the dense kind.
 *
 *   src/components/ui/table.tsx        the primitive: container
 *                                      `relative w-full overflow-x-auto`,
 *                                      table `w-full caption-bottom text-sm`,
 *                                      rows `hover:bg-muted/50 transition-colors
 *                                      data-[state=selected]:bg-muted`, head
 *                                      cells `h-10 text-left align-middle
 *                                      font-medium whitespace-nowrap`.
 *   src/pages/dashboard/audit-log.tsx  the dense screen idiom: outer
 *                                      `rounded-xl border border-edge
 *                                      bg-surface overflow-hidden`, header row
 *                                      `border-b border-edge-subtle`, header
 *                                      cells `px-5 py-3 text-2xs font-medium
 *                                      text-muted-foreground uppercase
 *                                      tracking-wider`, body cells `px-5 py-3.5`.
 *
 * Two deliberate corrections to the audit-log idiom:
 *
 *   1. Row hover is `hover:bg-muted/50` (the primitive's) rather than
 *      audit-log's `hover:bg-surface`. Since `--surface` is defined equal to
 *      `--background`, `hover:bg-surface` inside a `bg-surface` container is a
 *      no-op, so those rows have no hover feedback at all. `bg-muted/50` is
 *      what runcrate's own primitive uses and it actually reads.
 *   2. Dividers sit on the cells, not on `<tr>`. All four data tables use a
 *      sticky header, which needs `border-separate border-spacing-0` to keep
 *      its border while scrolling; in the separated-borders model a `<tr>`
 *      cannot paint a border at all. Same hairlines, same tier
 *      (`border-edge-subtle`), one level down the tree. This is also what lets
 *      a row carry the `border-l-2` retired/contested marker.
 */
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      <table
        className={cn(
          "w-full caption-bottom border-separate border-spacing-0 text-sm",
          className,
        )}
        data-slot="table"
        {...props}
      />
    </div>
  );
}

export function TableHeader({
  className,
  sticky = false,
  ...props
}: React.ComponentProps<"thead"> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        sticky && "[&_th]:sticky [&_th]:top-0 [&_th]:z-30 [&_th]:bg-surface",
        className,
      )}
      data-slot="table-header"
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      className={cn("[&_tr:last-child>td]:border-b-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      data-slot="table-row"
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 whitespace-nowrap border-b border-edge-subtle px-5 py-3 text-left align-middle font-medium text-2xs text-muted-foreground uppercase tracking-wider",
        className,
      )}
      data-slot="table-head"
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn(
        "whitespace-nowrap border-b border-edge-subtle px-5 py-3.5 align-middle",
        className,
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

/** runcrate's data-table container, from `src/pages/dashboard/audit-log.tsx`. */
export function TableShell({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-edge bg-surface",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The toolbar strip runcrate puts above a data table, inside the same container
 * — `flex items-center gap-3 flex-wrap px-5 py-3 border-b border-edge-subtle`.
 */
export function TableToolbar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 border-b border-edge-subtle px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}

/** The paginator strip runcrate puts below a data table, in the same container. */
export function TableFootbar({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-edge-subtle px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}
