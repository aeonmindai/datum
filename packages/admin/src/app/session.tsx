import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError, request, setUnauthorizedHandler, toApiError } from "../lib/api";
import type { Me, VerificationCapability } from "../lib/types";

const VERIFICATION_METHODS: Record<VerificationCapability["method"], true> = {
  "local-mirror": true,
  "github-api": true,
  none: true,
};

/**
 * `Me` is the one payload the entire shell reads directly — org, scope root,
 * sequence and verification capability all come from it. A reverse proxy or an
 * SPA fallback that swallows /admin/api and answers 200 with HTML would
 * otherwise be cast straight to `Me` and crash the first render, so the fields
 * that are actually used are checked once, here, and nowhere else.
 */
function readMe(payload: unknown): Me | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Partial<Me>;
  if (typeof candidate.org !== "string") return null;
  if (typeof candidate.scope_root !== "string") return null;
  if (typeof candidate.postgres !== "string") return null;
  if (typeof candidate.sequence !== "number") return null;
  const verification = candidate.verification;
  if (typeof verification !== "object" || verification === null) return null;
  if (typeof verification.configured !== "boolean") return null;
  if (!(verification.method in VERIFICATION_METHODS)) return null;
  return {
    authenticated: true,
    org: candidate.org,
    scope_root: candidate.scope_root,
    postgres: candidate.postgres,
    sequence: candidate.sequence,
    verification: {
      configured: verification.configured,
      method: verification.method,
    },
  };
}

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
    request<unknown>("/admin/api/me", { allowUnauthorized: true })
      .then((payload) => {
        if (cancelled) return;
        const me = readMe(payload);
        if (me === null) {
          setSession({
            status: "unreachable",
            error: new ApiError({
              status: 0,
              reason: "bad_gateway_payload",
              message:
                "/admin/api/me answered, but not with a Datum session. Something between this page and the server is intercepting /admin/api — a reverse proxy or an SPA fallback rule.",
              hint: "The whole panel depends on this payload, so it refuses to render a shell built on a guess.",
            }),
          });
          return;
        }
        setSession({ status: "authenticated", me });
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
