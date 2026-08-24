import type * as React from "react";
import { cn, variant as pick } from "../lib/cn";

/**
 * Base, variant and size strings copied verbatim from runcrate_app
 * `src/components/ui/button.tsx`. Same six variants (default / destructive /
 * outline / secondary / ghost / link) and the same four sizes.
 *
 * Two differences, both structural rather than visual: there is no cva (variant
 * maps are plain records looked up through `cn`) and no Radix `asChild` (the
 * hash router navigates through real anchors, so `LinkButton` renders an <a>
 * wearing the same classes). `iconSm` is an addition — runcrate's own header
 * and sidebar trigger reach for `size="icon" className="size-7"`, and a dense
 * admin table needs that shape often enough to name it.
 */
const buttonBase =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0";

const buttonVariants = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  destructive:
    "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
  outline: "border border-input bg-input-bg hover:bg-accent hover:text-accent-foreground",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const buttonSizes = {
  default: "h-10 px-5 py-2",
  sm: "h-8 rounded-lg px-3.5 text-xs",
  lg: "h-11 rounded-xl px-8",
  icon: "h-10 w-10",
  iconSm: "h-8 w-8 rounded-lg",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;
export type ButtonSize = keyof typeof buttonSizes;

export function buttonClass(
  variant?: ButtonVariant,
  size?: ButtonSize,
  className?: string,
) {
  return cn(
    buttonBase,
    pick(buttonVariants, variant, "default"),
    pick(buttonSizes, size, "default"),
    className,
  );
}

export interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={buttonClass(variant, size, className)}
      data-slot="button"
      type={type}
      {...props}
    />
  );
}

export interface LinkButtonProps extends React.ComponentProps<"a"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Anchor styled as a button — the hash router navigates through real links. */
export function LinkButton({
  className,
  variant,
  size,
  ...props
}: LinkButtonProps) {
  return (
    <a
      className={buttonClass(variant, size, className)}
      data-slot="button"
      {...props}
    />
  );
}
