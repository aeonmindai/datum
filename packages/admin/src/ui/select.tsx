import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * runcrate_app's Select is a Radix popover listbox. Radix is not a dependency
 * here, so this is a native <select> wearing runcrate's SelectTrigger class
 * string from `src/components/ui/select.tsx` — same `rounded-xl border
 * border-input bg-input-bg px-3.5 py-2 text-sm`, same `data-[size=default]:h-10
 * / data-[size=sm]:h-8` sizing, same `focus:border-ring` and
 * `aria-invalid:border-destructive`, same chevron in `text-muted-foreground`.
 *
 * A native control also gives keyboard and screen-reader behaviour for free,
 * which matters more on an admin panel than a custom popover does.
 */
export interface SelectProps
  extends Omit<React.ComponentProps<"select">, "size"> {
  /** Control height, matching runcrate's SelectTrigger sizes. Shadows the
   * native `size` attribute (a visible-row count) which a styled select never
   * uses. */
  size?: "sm" | "default";
  containerClassName?: string;
}

export function Select({
  className,
  containerClassName,
  size = "default",
  children,
  ...props
}: SelectProps) {
  return (
    <div className={cn("relative inline-flex w-full items-center", containerClassName)}>
      <select
        className={cn(
          "w-full cursor-pointer appearance-none items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-input bg-input-bg py-2 pr-9 pl-3.5 font-normal text-sm outline-none transition-colors",
          "focus:border-ring",
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
          size === "sm" ? "h-8" : "h-10",
          className,
        )}
        data-size={size}
        data-slot="select-trigger"
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-3 size-4 text-muted-foreground opacity-50"
      />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Convenience: a filter select with an "any" sentinel as the empty value. */
export function FilterSelect({
  options,
  anyLabel,
  ...props
}: Omit<SelectProps, "children"> & {
  options: readonly (SelectOption | string)[];
  anyLabel: string;
}) {
  return (
    <Select {...props}>
      <option value="">{anyLabel}</option>
      {options.map((o) => {
        const opt = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        );
      })}
    </Select>
  );
}
