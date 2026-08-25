import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

/**
 * Hover/focus popover. Class string from runcrate_app
 * `src/components/ui/hover-card.tsx`: `bg-popover text-popover-foreground z-50
 * rounded-md border p-4 shadow-md outline-hidden`. runcrate fixes its width at
 * `w-64`; this one takes a width because the provenance panel it carries is a
 * table of evidence rather than a one-line preview.
 *
 * Portalled to <body> so the table's `overflow-x-auto` container cannot clip
 * it, and positioned from the trigger's bounding box. Opens on hover and on
 * keyboard focus, closes on Escape and on blur, so the provenance detail is
 * reachable without a mouse.
 */
export function HoverCard({
  trigger,
  children,
  width = 380,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, placeAbove: false });
  const anchor = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  const place = useCallback(() => {
    const node = anchor.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    const margin = 8;
    const estimatedHeight = 260;
    const placeAbove = r.bottom + estimatedHeight + margin > window.innerHeight;
    const left = Math.min(
      Math.max(margin, r.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    setPos({
      top: placeAbove ? r.top - margin : r.bottom + margin,
      left,
      placeAbove,
    });
  }, [width]);

  useEffect(() => {
    if (!open) return;
    place();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, place]);

  return (
    <span
      className="relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      ref={anchor}
    >
      <span aria-describedby={open ? panelId : undefined} tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
        {trigger}
      </span>
      {open
        ? createPortal(
            <div
              className={cn(
                "datum-pop fixed z-[55] rounded-md border bg-popover p-4 text-popover-foreground shadow-md",
                className,
              )}
              id={panelId}
              role="tooltip"
              style={{
                top: pos.top,
                left: pos.left,
                width,
                transform: pos.placeAbove ? "translateY(-100%)" : undefined,
              }}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
