import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * echos_app's Select is a Radix popover listbox. Radix is not a dependency
 * here, so this is a native <select> wearing echos's SelectTrigger class
 * string — same `h-10` / `h-8` sizing, same border, same
 * `ring-[3px] ring-ring/50` focus ring, same chevron. A native control also
 * gives keyboard and screen-reader behaviour for free, which matters more on an
 * admin panel than a custom popover does.
 */
export interface SelectProps
  extends Omit<React.ComponentProps<"select">, "size"> {
  /** Control height, matching echos's SelectTrigger sizes. Shadows the native
   * `size` attribute (a visible-row count) which a styled select never uses. */
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
          "w-full cursor-pointer appearance-none items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-background py-2 pr-9 pl-3 font-normal text-sm shadow-none outline-none transition-all",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
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
        className="pointer-events-none absolute right-3 size-4 text-muted-foreground"
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
