import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  request,
  setUnauthorizedHandler,
  toApiError,
  type ApiError,
} from "../lib/api";
import type { Me } from "../lib/types";

export type SessionState =
  | { status: "checking" }
  | { status: "authenticated"; me: Me }
  | { status: "anonymous" }
  | { status: "unreachable"; error: ApiError };

interface SessionApi {
  session: SessionState;
  refresh: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionApi>({
  session: { status: "checking" },
  refresh: () => undefined,
  signOut: async () => undefined,
});

export function useSession() {
  return useContext(SessionContext);
}

/**
 * The authenticated `Me` payload, or throw. Only called from inside the
 * authenticated shell, where the session is guaranteed resolved.
 */
export function useMe(): Me {
  const { session } = useSession();
  if (session.status !== "authenticated") {
    throw new Error("useMe called outside an authenticated shell");
  }
  return session.me;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: "checking" });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // A 401 raised by any screen means the cookie died mid-session; drop to
    // anonymous so the shell stops rendering authenticated chrome.
    setUnauthorizedHandler(() => setSession({ status: "anonymous" }));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSession((prev) =>
      prev.status === "authenticated" ? prev : { status: "checking" },
    );
    request<Me>("/admin/api/me", { allowUnauthorized: true })
      .then((me) => {
        if (!cancelled) setSession({ status: "authenticated", me });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const error = toApiError(err);
        setSession(
          error.status === 401
            ? { status: "anonymous" }
            : { status: "unreachable", error },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const signOut = useCallback(async () => {
    try {
      await request<void>("/admin/api/logout", {
        method: "POST",
        allowUnauthorized: true,
      });
    } finally {
      setSession({ status: "anonymous" });
      window.location.hash = "/login";
    }
  }, []);

  const api = useMemo(
    () => ({ session, refresh, signOut }),
    [session, refresh, signOut],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}
