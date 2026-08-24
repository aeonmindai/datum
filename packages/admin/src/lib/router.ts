import { useEffect, useState } from "react";

/**
 * Hash router. The panel is a single static index.html served under /admin/,
 * so every route lives after the `#`. Query strings are supported after the
 * hash path: `#/assertions?scope=org/acme&live=true`.
 */

export interface Location {
  /** Path portion, always leading-slash, never empty. e.g. "/assertions/abc" */
  path: string;
  /** Parsed query params from after the `?` in the hash. */
  query: URLSearchParams;
}

function read(): Location {
  const raw = window.location.hash.replace(/^#/, "");
  const cut = raw.indexOf("?");
  const path = cut === -1 ? raw : raw.slice(0, cut);
  const query = new URLSearchParams(cut === -1 ? "" : raw.slice(cut + 1));
  return { path: path === "" ? "/" : path, query };
}

export function useLocation(): Location {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const onChange = () => setLoc(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return loc;
}

export function href(path: string, query?: Record<string, string | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") qs.set(k, v);
  }
  const tail = qs.toString();
  return `#${path}${tail ? `?${tail}` : ""}`;
}

export function navigate(
  path: string,
  query?: Record<string, string | undefined>,
) {
  window.location.hash = href(path, query).slice(1);
}

/** Replace the query on the current path without pushing a history entry. */
export function replaceQuery(
  path: string,
  query: Record<string, string | undefined>,
) {
  const next = href(path, query);
  if (next === window.location.hash) return;
  window.history.replaceState(null, "", next);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}
