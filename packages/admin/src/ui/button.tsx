import type * as React from "react";
import { cn, variant as pick } from "../lib/cn";

/**
 * Base + variant + size class strings taken from echos_app
 * `components/ui/button.tsx`. Dropped: `special` / `specialSecondary` /
 * `editOutline` / `destructiveOutline` (echos-brand gradients with no meaning
 * here) and Radix `asChild` (no @radix-ui/react-slot dependency). Kept: the
 * `default` variant's unusual text-only treatment, so a bare <Button> reads as
 * a quiet action exactly as it does in echos.
 */
const buttonBase =
  "inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium text-sm outline-none transition-all cursor-pointer focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0";

const buttonVariants = {
  default: "text-foreground hover:text-foreground/80",
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/30",
  destructive:
    "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
  outline:
    "border bg-background hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
  link: "text-primary underline-offset-4 hover:underline",
} as const;

const buttonSizes = {
  default: "h-10 px-4 py-2 has-[>svg]:px-3",
  sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
  lg: "h-12 rounded-md px-6 has-[>svg]:px-4",
  icon: "size-10",
  iconSm: "size-8",
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
