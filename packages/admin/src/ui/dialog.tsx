import { XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * runcrate_app's Dialog is Radix. Radix is not a dependency here, so this is the
 * same visual contract implemented directly. Class strings from
 * `src/components/ui/dialog.tsx`: overlay `fixed inset-0 z-50 bg-overlay`,
 * panel `fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)]
 * translate-x-[-50%] translate-y-[-50%] gap-4 rounded-2xl border
 * border-border/60 bg-background p-6 shadow-xl duration-200 sm:max-w-lg`,
 * header `flex flex-col gap-2 text-center sm:text-left`, title `text-lg
 * leading-none font-semibold`, description `text-muted-foreground text-sm`,
 * close button `absolute top-4 right-4 rounded-lg opacity-70 transition-opacity
 * hover:opacity-100`.
 *
 * The behaviour Radix gave for free — Escape to close, focus trap, focus
 * restore, scroll lock, aria wiring — is implemented below rather than dropped.
 *
 * One thing deliberately not copied: runcrate's DialogContent carries
 * `style={{ fontFamily: 'var(--font-figtree), system-ui, sans-serif' }}`, and
 * `--font-figtree` is not defined anywhere in that project. The declaration
 * therefore falls through to system-ui, so runcrate's own dialogs are the only
 * surface in the app that is not set in Geist. That is a bug, not a design
 * decision, and reproducing it would make the panel inconsistent with itself.
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
        className="datum-overlay fixed inset-0 z-50 bg-overlay"
        onMouseDown={close}
      />
      <div
        aria-describedby={description ? descId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          // grid-cols-1 resolves to minmax(0,1fr), which stops a wide child —
          // a long monospace secret, a JSON block — from blowing the panel out
          // past max-w-lg. runcrate's Radix dialog relies on Radix for this.
          "datum-dialog fixed top-[50%] left-[50%] z-50 grid grid-cols-1 max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-2xl border border-border/60 bg-background p-6 shadow-xl outline-none",
          size === "lg" ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
        data-slot="dialog-content"
        ref={panel}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex flex-col gap-2 pr-8 text-left" data-slot="dialog-header">
          <h2 className="font-semibold text-lg leading-none" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="text-muted-foreground text-sm" id={descId}>
              {description}
            </p>
          ) : null}
        </div>

        {children}

        {footer ? (
          <div className="border-border/60 border-t pt-4">
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              {footer}
            </div>
          </div>
        ) : null}

        {showCloseButton ? (
          <button
            className="absolute top-4 right-4 rounded-lg p-1 opacity-70 transition-opacity hover:bg-accent hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
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

/** Muted supporting text, opposite the actions in a dialog footer. */
export function DialogFooterLeft({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
      {children}
    </div>
  );
}

/** Actions side of a dialog footer. */
export function DialogFooterRight({ children }: { children?: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2">{children}</div>;
}
