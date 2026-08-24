import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * Class strings copied verbatim from runcrate_app `src/components/ui/tabs.tsx`:
 * list `bg-muted text-muted-foreground inline-flex h-10 w-fit items-center
 * justify-center rounded-xl p-1`, trigger `inline-flex h-full flex-1
 * items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm
 * font-medium whitespace-nowrap transition-colors focus-visible:ring-2
 * focus-visible:ring-ring/40` with the selected state
 * `bg-background text-foreground shadow-sm`.
 *
 * runcrate's tabs have no sliding indicator — the selected trigger simply gets
 * the background surface and a hairline shadow. The animated sliding indicator
 * that used to live here came from the previous design language, so it is gone
 * along with the measurement effect it needed; `transition-colors` is the whole
 * animation now.
 *
 * Behaviour is unchanged: controlled `value`, roving tabindex, and arrow keys
 * that move selection and focus together (with a roving tabindex, leaving focus
 * on the deselected tab would strand the focus ring on something Tab can no
 * longer reach).
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
  const move = (direction: 1 | -1) => {
    const at = items.findIndex((i) => i.value === value);
    const next = items[(at + direction + items.length) % items.length];
    if (!next) return;
    onValueChange(next.value);
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(
          `[role="tablist"][aria-label="${label}"] [role="tab"][aria-selected="true"]`,
        )
        ?.focus();
    }, 0);
  };

  return (
    <div
      aria-label={label}
      className={cn(
        "inline-flex h-10 w-fit items-center justify-center rounded-xl bg-muted p-1 text-muted-foreground",
        className,
      )}
      role="tablist"
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "inline-flex h-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 font-medium text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground",
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
                  "datum-num rounded-md px-1 text-2xs",
                  selected ? "bg-muted text-foreground" : "bg-accent text-muted-foreground",
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
