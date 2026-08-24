import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

/**
 * runcrate_app's DropdownMenu is Radix. Same class strings here, from
 * `src/components/ui/dropdown-menu.tsx`: content `bg-popover
 * text-popover-foreground min-w-[8rem] rounded-xl border border-border/60 p-1
 * shadow-lg`, items `relative flex cursor-default items-center gap-2 rounded-lg
 * px-2 py-1.5 text-sm select-none` with `focus:bg-accent
 * focus:text-accent-foreground`, destructive items `text-destructive
 * focus:bg-destructive/10`, label `px-2 py-1.5 text-sm font-medium`, separator
 * `bg-border -mx-1 my-1 h-px`. Implemented with a click-outside listener and
 * Escape handling instead of a Radix portal.
 */
export interface DropdownMenuProps {
  trigger: (props: {
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    ref: (node: HTMLButtonElement | null) => void;
  }) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}

export function DropdownMenu({
  trigger,
  children,
  align = "end",
  className,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const setTriggerRef = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative inline-flex" ref={host}>
      {trigger({
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
        "aria-haspopup": "menu",
        ref: setTriggerRef,
      })}
      {open ? (
        <div
          className={cn(
            "datum-pop absolute top-[calc(100%+4px)] z-50 min-w-[8rem] overflow-x-hidden overflow-y-auto rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg",
            align === "end" ? "right-0" : "left-0",
            className,
          )}
          data-slot="dropdown-menu-content"
          onClick={() => setOpen(false)}
          role="menu"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface DropdownMenuItemProps
  extends React.ComponentProps<"button"> {
  variant?: "default" | "destructive";
}

export function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: DropdownMenuItemProps) {
  return (
    <button
      className={cn(
        "relative flex w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "destructive" &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg]:!text-destructive",
        className,
      )}
      data-slot="dropdown-menu-item"
      role="menuitem"
      type="button"
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("px-2 py-1.5 font-medium text-sm", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
