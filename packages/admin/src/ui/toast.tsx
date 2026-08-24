import { CircleCheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

/**
 * runcrate_app uses Sonner. Its styling is what carries over, from
 * `src/components/ui/sonner.tsx`: the toast is `bg-surface border border-edge`,
 * the title is `text-foreground`, the body is `text-muted-foreground`. The
 * elevation is `shadow-floating` — one of the three per-theme shadow tokens
 * runcrate defines in its tailwind config precisely for detached surfaces.
 *
 * Two things not copied. runcrate's per-tone Sonner classNames are raw
 * `bg-red-50 / bg-green-50 / bg-yellow-50` literals, which are outside the
 * palette and read as a different product; the tone here is carried by the icon
 * instead, `text-foreground` for success and `text-destructive` plus a
 * `border-destructive/50` edge for failure. And the queue is a small context
 * rather than a dependency.
 */
export type ToastTone = "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

interface ToastApi {
  push: (toast: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}

const LIFETIME_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { ...toast, id }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2"
        role="status"
      >
        {toasts.map((toast) => (
          <div
            className={cn(
              "datum-toast pointer-events-auto flex w-88 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border bg-surface p-4 shadow-floating",
              toast.tone === "error" ? "border-destructive/50" : "border-edge",
            )}
            key={toast.id}
          >
            {toast.tone === "success" ? (
              <CircleCheckIcon
                aria-hidden
                className="mt-px size-4 shrink-0 text-foreground"
              />
            ) : (
              <TriangleAlertIcon
                aria-hidden
                className="mt-px size-4 shrink-0 text-destructive"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-medium text-foreground text-sm leading-none">
                {toast.title}
              </p>
              {toast.body ? (
                <p className="text-muted-foreground text-sm">{toast.body}</p>
              ) : null}
            </div>
            <button
              className="flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              onClick={() => dismiss(toast.id)}
              type="button"
            >
              <XIcon className="size-3.5" />
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
