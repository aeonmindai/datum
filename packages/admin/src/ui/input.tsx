import type * as React from "react";
import { cn } from "../lib/cn";

/**
 * Class strings copied verbatim from runcrate_app:
 *   src/components/ui/input.tsx     — `flex h-10 w-full min-w-0 rounded-xl
 *                                     border border-input bg-input-bg px-3.5
 *                                     py-2 text-base transition-colors
 *                                     outline-none md:text-sm`, plus
 *                                     `focus:border-ring` and
 *                                     `aria-invalid:border-destructive`.
 *   src/components/ui/textarea.tsx  — same treatment, `field-sizing-content
 *                                     min-h-16 py-2.5`.
 *   src/components/ui/label.tsx     — `flex items-center gap-2 text-sm
 *                                     leading-none font-medium select-none`.
 *
 * Note what runcrate's focus state is: the border turns `--ring` blue. There is
 * no ring halo on inputs at all — only buttons and tabs get
 * `focus-visible:ring-2 ring-ring/40`. Keyboard focus still lands somewhere
 * unmistakable, and the form does not glow.
 *
 * The `suffix` slot and its `pr-10` are this panel's, not runcrate's: the key
 * dialog and the as-of control both need an affordance inside the field.
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
          "flex h-10 w-full min-w-0 rounded-xl border border-input bg-input-bg px-3.5 py-2 text-base outline-none transition-colors selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus:border-ring",
          "aria-invalid:border-destructive",
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

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-xl border border-input bg-input-bg px-3.5 py-2.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus:border-ring aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

/** runcrate `label.tsx` minus the Radix primitive. */
export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn(
        "flex select-none items-center gap-2 font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      data-slot="label"
      {...props}
    />
  );
}

/** Field wrapper — `grid gap-2`, the spacing runcrate's forms use. */
export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-2", className)} {...props} />;
}

/** Supporting copy under a field. */
export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("text-muted-foreground text-sm", className)} {...props} />
  );
}

/** Validation message under a field. */
export function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-destructive text-sm", className)} {...props} />;
}
