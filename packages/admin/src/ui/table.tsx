import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Copied from echos_app `components/ui/table.tsx`: the
 * `border-separate border-spacing-0` table, the `#FAFAFA` header with `#404040`
 * text and `h-11` cells, the `sticky` header prop, `hover:bg-muted/50` rows,
 * and the `border-r-[0.5px] border-r-[#E5E5E5] last:border-r-0` cell hairlines.
 * The hex values are echos's own hardcoded ones, kept so the two tables are
 * visually identical.
 */
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      className="relative w-full overflow-x-auto"
      data-slot="table-container"
    >
      <table
        className={cn(
          "w-full caption-bottom text-sm border-separate border-spacing-0",
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
        "[&_tr]:border-b bg-[#FAFAFA]",
        sticky && "[&_th]:sticky [&_th]:top-0 [&_th]:z-30 [&_th]:bg-[#FAFAFA]",
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
      className={cn("[&_tr:last-child]:border-0", className)}
      data-slot="table-body"
      {...props}
    />
  );
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
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
        "h-11 whitespace-nowrap px-4 text-left align-middle font-medium text-[#404040]",
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
        "whitespace-nowrap px-4 py-2 align-middle border-r-[0.5px] border-r-[#E5E5E5] last:border-r-0",
        className,
      )}
      data-slot="table-cell"
      {...props}
    />
  );
}

/** Bordered shell that gives the table echos's card-like outer edge. */
export function TableShell({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "datum-scroll overflow-hidden rounded-xl border-[0.5px] border-[#E5E5E5] bg-background",
        className,
      )}
      {...props}
    />
  );
}
