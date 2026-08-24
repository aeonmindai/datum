import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "./router";

/**
 * Every refusal from the server arrives as
 * `{ ok:false, reason, invariant?, message?, says?, hint?, detail?, sqlstate? }`.
 * ApiError carries all of it so an error state can show the store's own words
 * instead of a generic "something went wrong".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly invariant?: number;
  readonly says?: string;
  readonly hint?: string;
  readonly detail?: Record<string, unknown>;
  readonly sqlstate?: string;

  constructor(init: {
    status: number;
    reason: string;
    message: string;
    invariant?: number;
    says?: string;
    hint?: string;
    detail?: Record<string, unknown>;
    sqlstate?: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.reason = init.reason;
    if (init.invariant !== undefined) this.invariant = init.invariant;
    if (init.says !== undefined) this.says = init.says;
    if (init.hint !== undefined) this.hint = init.hint;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.sqlstate !== undefined) this.sqlstate = init.sqlstate;
  }
}

export interface RefusalBody {
  ok?: false;
  reason?: string;
  invariant?: number;
  message?: string;
  says?: string;
  hint?: string;
  detail?: Record<string, unknown>;
  sqlstate?: string;
}

/** Set by the shell so a 401 anywhere can drop the cached session. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 400);
  }
}

/**
 * Refusal bodies are a fixed server contract, so the parsed payload is
 * asserted to `RefusalBody` once, here, rather than re-guarded field by field.
 * A non-object body (empty, a proxy's HTML, a bare string) collapses to an
 * empty refusal and the HTTP status carries the meaning.
 */
async function readRefusal(res: Response): Promise<RefusalBody> {
  const parsed = await parseJson(res);
  if (typeof parsed === "string") return { message: parsed };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as RefusalBody;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  /** Suppress the automatic redirect to #/login on a 401 (the login screen). */
  allowUnauthorized?: boolean;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, signal, allowUnauthorized } = options;

  let res: Response;
  try {
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    };
    res = await fetch(path, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError({
      status: 0,
      reason: "unreachable",
      message:
        "Could not reach the Datum server. It may be starting, stopped, or blocked by the network.",
      hint: `No response from ${path}.`,
    });
  }

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    const b = await readRefusal(res);
    if (res.status === 401 && !allowUnauthorized) {
      onUnauthorized?.();
      navigate("/login");
    }
    throw new ApiError({
      status: res.status,
      reason: b.reason ?? `http_${res.status}`,
      message: b.message ?? `${res.status} ${res.statusText}`,
      ...(b.invariant !== undefined ? { invariant: b.invariant } : {}),
      ...(b.says !== undefined ? { says: b.says } : {}),
      ...(b.hint !== undefined ? { hint: b.hint } : {}),
      ...(b.detail !== undefined ? { detail: b.detail } : {}),
      ...(b.sqlstate !== undefined ? { sqlstate: b.sqlstate } : {}),
    });
  }

  return (await parseJson(res)) as T;
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({
    status: 0,
    reason: "client_error",
    message: err instanceof Error ? err.message : String(err),
  });
}

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | undefined>) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True only on the first load. Polling refreshes never blank the screen. */
  loading: boolean;
  /** True while a background refresh is in flight. */
  refreshing: boolean;
  reload: () => void;
}

export interface UseResourceOptions {
  /** Poll interval in ms. Paused while the document is hidden. */
  pollMs?: number;
  /** Skip fetching entirely (e.g. unauthenticated). */
  enabled?: boolean;
}

/**
 * Minimal data hook: one in-flight request per path, abortable, optionally
 * polled while the tab is visible. Deliberately not a cache — the panel reads
 * an append-only store where staleness is the thing we are trying to avoid.
 */
export function useResource<T>(
  path: string | null,
  options: UseResourceOptions = {},
): Resource<T> {
  const { pollMs, enabled = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const loadedPath = useRef<string | null>(null);

  const active = enabled && path !== null;

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const fresh = loadedPath.current !== path;
    if (fresh) {
      setLoading(true);
      setData(undefined);
      setError(undefined);
    } else {
      setRefreshing(true);
    }

    request<T>(path, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        loadedPath.current = path;
        setData(value);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        loadedPath.current = path;
        setError(toApiError(err));
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => controller.abort();
  }, [path, active, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!active || !pollMs) return;
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") reload();
    };
    const start = () => {
      timer = window.setInterval(tick, pollMs);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        reload();
        if (timer === undefined) start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, pollMs, reload]);

  return { data, error, loading, refreshing, reload };
}
