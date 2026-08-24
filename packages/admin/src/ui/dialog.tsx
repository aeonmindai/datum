import { XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * echos_app's Dialog is Radix. Radix is not a dependency here, so this is the
 * same visual contract implemented directly: overlay
 * `bg-black/50 backdrop-blur-xs`, panel
 * `rounded-2xl border-[0.5px] border-neutral-200 bg-white p-6 sm:max-w-lg`,
 * close button `top-4 right-4` with `hover:scale-110`, title
 * `text-xl font-semibold`, footer `border-t pt-4`. The behaviour Radix gave for
 * free — Escape to close, focus trap, focus restore, scroll lock, aria wiring —
 * is implemented below rather than dropped.
 */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Wider panel for the two-column contradiction resolve dialog. */
  size?: "default" | "lg";
  showCloseButton?: boolean;
  /** Escape and overlay click are disabled while a request is in flight. */
  dismissable?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "default",
  showCloseButton = true,
  dismissable = true,
}: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const close = useCallback(() => {
    if (dismissable) onClose();
  }, [dismissable, onClose]);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    const node = panel.current;
    if (node) {
      const preferred =
        node.querySelector<HTMLElement>("[data-autofocus]") ??
        node.querySelector<HTMLElement>(FOCUSABLE) ??
        node;
      preferred.focus();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const host = panel.current;
      if (!host) return;
      const items = Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        host.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <>
      <div
        aria-hidden
        className="datum-overlay fixed inset-0 z-50 bg-black/50 backdrop-blur-xs"
        onMouseDown={close}
      />
      <div
        aria-describedby={description ? descId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          // grid-cols-1 resolves to minmax(0,1fr), which stops a wide child —
          // a long monospace secret, a JSON block — from blowing the panel out
          // past max-w-lg. echos's Radix dialog relies on Radix for this.
          "datum-dialog fixed top-[50%] left-[50%] z-50 grid grid-cols-1 max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-2xl border-[0.5px] border-neutral-200 bg-white p-6 shadow-md backdrop-blur-sm outline-none",
          size === "lg" ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
        data-slot="dialog-content"
        ref={panel}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex flex-col gap-1.5 pr-8 text-left" data-slot="dialog-header">
          <h2 className="font-semibold text-xl leading-tight" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="text-muted-foreground text-sm leading-relaxed" id={descId}>
              {description}
            </p>
          ) : null}
        </div>

        {children}

        {footer ? (
          <div className="border-border border-t pt-4">
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              {footer}
            </div>
          </div>
        ) : null}

        {showCloseButton ? (
          <button
            className="absolute top-4 right-4 rounded-md p-1 text-[#737373] opacity-90 transition-all hover:scale-110 hover:bg-accent hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={onClose}
            type="button"
          >
            <XIcon className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        ) : null}
      </div>
    </>,
    document.body,
  );
}

/** echos `DialogFooterLeft` — muted supporting text opposite the actions. */
export function DialogFooterLeft({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
      {children}
    </div>
  );
}

/** echos `DialogFooterRight`. */
export function DialogFooterRight({ children }: { children?: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2">{children}</div>;
}
