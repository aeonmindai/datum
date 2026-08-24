import {
  AlarmClockOffIcon,
  LockIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSession } from "../app/session";
import { request, toApiError, type ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { Button } from "../ui/button";
import { Field, FieldError, Input, Label } from "../ui/input";
import { CodeBadge } from "../ui/badge";

/**
 * The three refusals this screen must tell apart:
 *
 *   401 unauthorized             — wrong password, retry immediately
 *   429 unauthorized + detail    — rate limited, retry after N seconds
 *   status 0 unreachable         — the server is not answering at all
 *
 * They get different icons, different copy and different affordances, because
 * "wrong password" and "locked out for 43 seconds" are not the same problem and
 * a shared red banner would make the operator guess.
 */
type Failure =
  | { kind: "rejected" }
  | { kind: "throttled"; retryAfter: number | null }
  | { kind: "unreachable"; error: ApiError }
  | { kind: "other"; error: ApiError };

function classify(error: ApiError): Failure {
  if (error.status === 429) {
    const raw = error.detail?.retry_after_seconds;
    const retryAfter = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    return { kind: "throttled", retryAfter };
  }
  if (error.status === 401) return { kind: "rejected" };
  if (error.status === 0) return { kind: "unreachable", error };
  return { kind: "other", error };
}

export function LoginScreen() {
  const { refresh } = useSession();
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const locked = cooldown > 0;
  const invalid = failure?.kind === "rejected" || failure?.kind === "throttled";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || locked) return;
    setSubmitting(true);
    setFailure(null);
    try {
      await request<void>("/admin/api/login", {
        method: "POST",
        body: { password },
        allowUnauthorized: true,
      });
      setPassword("");
      refresh();
      window.location.hash = "/";
    } catch (err: unknown) {
      const classified = classify(toApiError(err));
      setFailure(classified);
      if (classified.kind === "throttled" && classified.retryAfter !== null) {
        setCooldown(Math.ceil(classified.retryAfter));
      }
      field.current?.focus();
      field.current?.select();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-sidebar p-6">
      <div className="flex w-full max-w-md flex-col gap-6">
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

        <form
          className="flex flex-col gap-6 rounded-2xl border-[0.5px] border-neutral-200 bg-white p-6 shadow-sm"
          noValidate
          onSubmit={submit}
        >
          <div className="flex flex-col gap-1.5">
            <h1 className="font-semibold text-xl leading-tight">Sign in</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              One shared password guards the human view of this instance. Agents
              authenticate separately, with scoped keys.
            </p>
          </div>

          <Field>
            <Label htmlFor="datum-password">Admin password</Label>
            <Input
              aria-describedby={failure ? "datum-login-failure" : undefined}
              aria-invalid={invalid || undefined}
              autoComplete="current-password"
              disabled={submitting || locked}
              id="datum-password"
              name="password"
              onChange={(e) => {
                setPassword(e.target.value);
                if (failure?.kind === "rejected") setFailure(null);
              }}
              ref={field}
              type="password"
              value={password}
            />
            {failure?.kind === "rejected" ? (
              <FieldError id="datum-login-failure">
                That password was not accepted.
              </FieldError>
            ) : null}
          </Field>

          {failure && failure.kind !== "rejected" ? (
            <FailurePanel failure={failure} cooldown={cooldown} />
          ) : null}

          <Button
            className="w-full"
            disabled={submitting || locked || password.length === 0}
            size="lg"
            type="submit"
            variant="primary"
          >
            <LockIcon />
            {locked
              ? `Locked — ${cooldown}s`
              : submitting
                ? "Signing in…"
                : "Sign in"}
          </Button>
        </form>

        <p className="px-1 text-muted-foreground text-sm">
          No password set? The server refuses to boot without one. Generate a
          hash with <code className="font-mono text-[13px]">datum hash-password</code>{" "}
          and set <code className="font-mono text-[13px]">DATUM_ADMIN_PASSWORD_HASH</code>.
        </p>
      </div>
    </div>
  );
}

function FailurePanel({
  failure,
  cooldown,
}: {
  failure: Exclude<Failure, { kind: "rejected" }>;
  cooldown: number;
}) {
  const shell =
    "flex items-start gap-3 rounded-lg border-[0.5px] px-4 py-3 text-sm";

  if (failure.kind === "throttled") {
    return (
      <div
        className={cn(shell, "border-warning/40 bg-warning/10")}
        id="datum-login-failure"
        role="alert"
      >
        <AlarmClockOffIcon
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-warning-foreground"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-warning-foreground">
            Too many attempts
          </p>
          <p className="text-warning-foreground/80">
            {cooldown > 0 ? (
              <>
                Rate limited. Try again in{" "}
                <span className="datum-num font-medium">{cooldown}</span>{" "}
                second{cooldown === 1 ? "" : "s"}.
              </>
            ) : failure.retryAfter === null ? (
              "Rate limited. The server did not say for how long — wait a moment and try again."
            ) : (
              "The lockout has expired. Try again."
            )}
          </p>
          <CodeBadge className="mt-1" variant="warning">
            429 unauthorized
          </CodeBadge>
        </div>
      </div>
    );
  }

  if (failure.kind === "unreachable") {
    return (
      <div
        className={cn(shell, "border-destructive/40 bg-destructive/5")}
        id="datum-login-failure"
        role="alert"
      >
        <WifiOffIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-medium text-destructive">Server not reachable</p>
          <p className="text-foreground/80">{failure.error.message}</p>
          <CodeBadge className="mt-1" variant="danger">
            unreachable
          </CodeBadge>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(shell, "border-destructive/40 bg-destructive/5")}
      id="datum-login-failure"
      role="alert"
    >
      <TriangleAlertIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium text-destructive">Sign-in failed</p>
        <p className="text-foreground/80">{failure.error.message}</p>
        <CodeBadge className="mt-1" variant="danger">
          {failure.error.status > 0
            ? `${failure.error.status} ${failure.error.reason}`
            : failure.error.reason}
        </CodeBadge>
      </div>
    </div>
  );
}
