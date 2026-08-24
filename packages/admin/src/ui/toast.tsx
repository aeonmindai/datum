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
 * echos_app uses Sonner. Its styling is what carries over
 * (`components/ui/sonner.tsx`): `w-[394px] rounded-xl border border-neutral-200
 * p-4` with the custom
 * `shadow-[0px_10px_15px_-3px_rgba(0,0,0,0.1),0px_4px_6px_-2px_rgba(0,0,0,0.05)]`,
 * a primary-coloured check for success, and a white `size-6` close button.
 * The queue itself is a small context rather than a dependency.
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
              "datum-toast pointer-events-auto flex w-[394px] max-w-[calc(100vw-2rem)] items-start gap-3 rounded-xl border border-neutral-200 bg-white p-4",
              "shadow-[0px_10px_15px_-3px_rgba(0,0,0,0.1),0px_4px_6px_-2px_rgba(0,0,0,0.05)]",
            )}
            key={toast.id}
          >
            {toast.tone === "success" ? (
              <CircleCheckIcon aria-hidden className="mt-px size-5 shrink-0 text-primary" />
            ) : (
              <TriangleAlertIcon
                aria-hidden
                className="mt-px size-5 shrink-0 text-destructive"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="font-medium text-sm leading-5">{toast.title}</p>
              {toast.body ? (
                <p className="text-muted-foreground text-sm leading-5">{toast.body}</p>
              ) : null}
            </div>
            <button
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-white text-muted-foreground transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
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
