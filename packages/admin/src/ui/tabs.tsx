import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Port of echos_app `components/ui/animated-tabs.tsx`: the list is
 * `rounded-md bg-neutral-50 border border-neutral-200` with `h-10 gap-0.5 p-0.5`
 * (echos's `size="md"`), triggers are `rounded-sm text-muted-foreground`
 * turning `text-primary` when selected, and a white indicator
 * `rounded-sm border border-neutral-200 bg-white shadow-sm` slides between them
 * with `transition-all duration-300 ease-in-out`.
 *
 * The measurement approach is echos's too — read the selected trigger's
 * bounding box relative to the list and position an absolute div — but driven by
 * the controlled `value` prop rather than a MutationObserver on Radix's
 * aria-selected attribute.
 */
export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  label: string;
  className?: string;
}

export function Tabs<T extends string>({
  items,
  value,
  onValueChange,
  label,
  className,
}: TabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });

  const update = useCallback(() => {
    const host = list.current;
    if (!host) return;
    const active = host.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    const a = active.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    setIndicator({
      left: a.left - h.left,
      top: a.top - h.top,
      width: a.width,
      height: a.height,
    });
  }, []);

  useEffect(() => {
    const id = window.setTimeout(update, 0);
    window.addEventListener("resize", update);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("resize", update);
    };
  }, [update, value, items]);

  const move = (direction: 1 | -1) => {
    const at = items.findIndex((i) => i.value === value);
    const next = items[(at + direction + items.length) % items.length];
    if (next) onValueChange(next.value);
  };

  return (
    <div className={cn("relative w-fit", className)} ref={list}>
      <div
        aria-label={label}
        className="relative inline-flex h-10 w-fit items-center justify-center gap-0.5 rounded-md border border-neutral-200 bg-neutral-50 p-0.5 text-muted-foreground"
        role="tablist"
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              aria-selected={selected}
              className={cn(
                "z-10 inline-flex h-full cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border border-transparent px-3 font-medium text-sm transition-colors hover:bg-neutral-200/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-selected:hover:bg-transparent",
                selected ? "text-primary" : "text-muted-foreground",
              )}
              key={item.value}
              onClick={() => onValueChange(item.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  move(-1);
                }
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {item.label}
              {item.count === undefined ? null : (
                <span
                  className={cn(
                    "datum-num rounded-sm px-1 text-[11px]",
                    selected
                      ? "bg-primary/10 text-primary"
                      : "bg-neutral-200/70 text-muted-foreground",
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {indicator.width > 0 ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-sm border border-neutral-200 bg-white shadow-sm transition-all duration-300 ease-in-out"
          style={{ ...indicator, zIndex: 5 }}
        />
      ) : null}
    </div>
  );
}
