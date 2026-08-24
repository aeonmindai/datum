import { CompassIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect } from "react";
import { SessionProvider, useSession } from "./app/session";
import { MobileNav, Shell } from "./app/shell";
import { useLocation } from "./lib/router";
import type { Location } from "./lib/router";
import { href } from "./lib/router";
import { AssertionDetailScreen } from "./screens/assertion-detail";
import { AssertionsScreen, readFilters } from "./screens/assertions";
import { ContradictionsScreen } from "./screens/contradictions";
import { KeysScreen } from "./screens/keys";
import { LoginScreen } from "./screens/login";
import { MissionsScreen } from "./screens/missions";
import { NodesScreen } from "./screens/nodes";
import { OverviewScreen } from "./screens/overview";
import { RejectionsScreen } from "./screens/rejections";
import { ScopesScreen } from "./screens/scopes";
import type { ContradictionStatus, Me } from "./lib/types";
import { LinkButton } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { EmptyState, ErrorState } from "./ui/states";
import { ToastProvider } from "./ui/toast";

const CONTRADICTION_STATUSES: readonly (ContradictionStatus | "all")[] = [
  "open",
  "resolved",
  "superseded",
  "unreproducible",
  "all",
];

function titleFor(path: string): string {
  if (path === "/") return "Overview";
  if (path.startsWith("/assertions/")) return "Assertion";
  if (path === "/assertions") return "Assertions";
  if (path === "/contradictions") return "Contradictions";
  if (path === "/missions") return "Missions";
  if (path === "/scopes") return "Scopes";
  if (path === "/keys") return "API keys";
  if (path === "/rejections") return "Rejected writes";
  if (path === "/nodes") return "Nodes";
  return "Not found";
}

function Routed({ location, me }: { location: Location; me: Me }) {
  const { path, query } = location;

  if (path === "/") return <OverviewScreen org={me.org} />;

  if (path.startsWith("/assertions/")) {
    const id = decodeURIComponent(path.slice("/assertions/".length));
    return <AssertionDetailScreen id={id} sequence={me.sequence} />;
  }

  if (path === "/assertions") {
    return <AssertionsScreen filters={readFilters(query)} />;
  }

  if (path === "/contradictions") {
    const raw = query.get("status") ?? "open";
    const status = CONTRADICTION_STATUSES.includes(raw as ContradictionStatus | "all")
      ? (raw as ContradictionStatus | "all")
      : "open";
    return <ContradictionsScreen status={status} />;
  }

  if (path === "/missions") {
    return <MissionsScreen scope={query.get("scope") ?? ""} />;
  }

  if (path === "/scopes") return <ScopesScreen scopeRoot={me.scope_root} />;
  if (path === "/keys") return <KeysScreen scopeRoot={me.scope_root} />;
  if (path === "/rejections") return <RejectionsScreen />;
  if (path === "/nodes") return <NodesScreen />;

  return (
    <EmptyState
      action={
        <LinkButton href={href("/")} variant="outline">
          Back to overview
        </LinkButton>
      }
      body={`Nothing is routed at ${path}. The panel is entirely hash-routed, so a stale bookmark or a hand-edited fragment lands here.`}
      icon={CompassIcon}
      title="No such screen"
    />
  );
}

function Booting() {
  return (
    <div className="flex min-h-svh flex-col gap-6 bg-sidebar p-6">
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ShieldCheckIcon aria-hidden className="size-4" />
        </span>
        <span className="font-semibold text-foreground">Datum</span>
      </div>
      <div className="flex flex-1 flex-col gap-4 rounded-xl border border-sidebar-border bg-background p-6">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

function Routes() {
  const location = useLocation();
  const { session, refresh } = useSession();
  const onLogin = location.path === "/login";

  // An expired cookie leaves the hash pointing at a screen that cannot load, so
  // send the operator to the login form rather than an empty shell.
  useEffect(() => {
    if (session.status === "anonymous" && !onLogin) {
      window.location.hash = "/login";
    }
  }, [session.status, onLogin]);

  // Already signed in and sitting on the login form: nothing to do here.
  useEffect(() => {
    if (session.status === "authenticated" && onLogin) {
      window.location.hash = "/";
    }
  }, [session.status, onLogin]);

  if (session.status === "checking") return <Booting />;

  if (session.status === "unreachable") {
    return (
      <div className="flex min-h-svh items-center justify-center bg-sidebar p-6">
        <div className="flex w-full max-w-xl flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheckIcon aria-hidden className="size-5" />
            </span>
            <div className="flex flex-col leading-tight">
              <span className="font-semibold text-foreground text-lg">Datum</span>
              <span className="text-muted-foreground text-sm">
                Append-only fact store
              </span>
            </div>
          </div>
          <ErrorState
            error={session.error}
            onRetry={refresh}
            title="This instance is not answering"
          />
          <p className="text-muted-foreground text-sm">
            The panel is static and loaded fine; the API behind it did not respond.
            Check that the server process is up and that it can reach Postgres — it
            fails closed on purpose rather than serving a half-working store.
          </p>
          <LinkButton className="w-fit" href={href("/login")} variant="outline">
            Go to sign in
          </LinkButton>
        </div>
      </div>
    );
  }

  if (session.status === "anonymous" || onLogin) return <LoginScreen />;

  return (
    <Shell
      currentPath={location.path}
      me={session.me}
      title={titleFor(location.path)}
    >
      <MobileNav currentPath={location.path} />
      <Routed location={location} me={session.me} />
    </Shell>
  );
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Routes />
      </ToastProvider>
    </SessionProvider>
  );
}
