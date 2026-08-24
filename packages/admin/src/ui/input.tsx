import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Class string from echos_app `components/ui/input.tsx`, including the
 * `h-10`, `ring-[3px] ring-ring/50` focus treatment, the
 * `aria-invalid:border-destructive` error state, and the optional `suffix`
 * slot with its `pr-10`.
 */
export interface InputProps extends React.ComponentProps<"input"> {
  suffix?: React.ReactNode;
  containerClassName?: string;
}

export function Input({
  className,
  containerClassName,
  type,
  suffix,
  ...props
}: InputProps) {
  return (
    <div className={cn("relative flex w-full items-center", containerClassName)}>
      <input
        className={cn(
          "flex h-10 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          suffix ? "pr-10" : undefined,
          className,
        )}
        data-slot="input"
        type={type}
        {...props}
      />
      {suffix ? (
        <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center">
          {suffix}
        </div>
      ) : null}
    </div>
  );
}

/** Same border, focus ring and invalid treatment as Input, sized for prose. */
export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

/** Label — echos `components/ui/label.tsx` minus the Radix primitive. */
export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex select-none items-center gap-2 font-medium text-sm leading-none",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

/** echos `FormItem` (`grid gap-2`) from `components/ui/form.tsx`. */
export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-2", className)} {...props} />;
}

/** echos `FormDescription`. */
export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}

/** echos `FormMessage`. */
export function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-destructive text-sm", className)} {...props} />;
}
