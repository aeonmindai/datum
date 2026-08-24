import type * as React from "react";
import { cn } from "../lib/cn";
import { Table, TableBody, TableCell, TableRow } from "./table";

/** runcrate_app `src/components/ui/skeleton.tsx`, verbatim. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-accent", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

/**
 * Skeleton rows shaped like the table that is loading — column count and
 * per-column widths come from the caller so the placeholder does not reflow
 * into something a different width when the data lands. The bar is one
 * `text-sm` line box tall (1.375rem), which is exactly the height of a real
 * single-line row inside the same `py-3.5` cell, so the table does not jump
 * either.
 */
export function TableSkeleton({
  columns,
  rows = 6,
}: {
  columns: readonly string[];
  rows?: number;
}) {
  return (
    <Table>
      <TableBody>
        {Array.from({ length: rows }, (_, r) => (
          <TableRow key={r} className="hover:bg-transparent">
            {columns.map((width, c) => (
              <TableCell key={c}>
                <Skeleton className="h-[1.375rem]" style={{ width }} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Card-shaped placeholder for the stat grid and the contradiction queue. */
export function BlockSkeleton({
  count = 3,
  height = "h-28",
  className,
}: {
  count?: number;
  height?: string;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-4", className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn("w-full rounded-2xl", height)} />
      ))}
    </div>
  );
}
