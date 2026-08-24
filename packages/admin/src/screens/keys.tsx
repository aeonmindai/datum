import {
  BanIcon,
  KeyRoundIcon,
  MoonIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { request, toApiError, useResource, type ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { absoluteTime, ageMs, relativeTime, SEVEN_DAYS } from "../lib/format";
import { PERMISSIONS, type ApiKey, type Permission } from "../lib/types";
import { Badge, CodeBadge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogFooterLeft, DialogFooterRight } from "../ui/dialog";
import { Field, FieldError, FieldHint, Input, Label } from "../ui/input";
import { CopyButton, Mono, PageHeader } from "../ui/primitives";
import { TableSkeleton } from "../ui/skeleton";
import { EmptyState, ErrorState } from "../ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableShell,
} from "../ui/table";
import { useToast } from "../ui/toast";

interface KeysResponse {
  keys: ApiKey[];
}

interface CreatedKey {
  key: ApiKey;
  secret: string;
}

const COLUMNS = [
  "prefix",
  "label",
  "scope",
  "permissions",
  "expires",
  "last used",
  "uses",
  "",
] as const;

export function KeysScreen({ scopeRoot }: { scopeRoot: string }) {
  const keys = useResource<KeysResponse>("/admin/api/keys");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  return (
    <>
      <PageHeader
        actions={
          <Button onClick={() => setCreating(true)} variant="primary">
            <PlusIcon />
            New key
          </Button>
        }
        description="Agent credentials. Each key is bound to one scope and one permission set; the secret is shown once, at creation, and never stored in a form we can read back."
        title="API keys"
      />

      {keys.loading ? (
        <TableShell>
          <TableSkeleton
            columns={["6rem", "10rem", "12rem", "9rem", "6rem", "5rem", "3rem", "4rem"]}
          />
        </TableShell>
      ) : keys.error ? (
        <ErrorState error={keys.error} onRetry={keys.reload} title="Could not load keys" />
      ) : (keys.data?.keys.length ?? 0) === 0 ? (
        <EmptyState
          action={
            <Button onClick={() => setCreating(true)} variant="primary">
              <PlusIcon />
              Mint the first key
            </Button>
          }
          body="Nothing can write to this store yet. Mint a scoped key for the first agent, give it only the permissions it needs, and it will show up here with its usage."
          icon={KeyRoundIcon}
          title="No keys yet"
        />
      ) : (
        <TableShell>
          <Table>
            <TableHeader sticky>
              <TableRow className="hover:bg-transparent">
                {COLUMNS.map((c, i) => (
                  <TableHead key={c || i}>{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data?.keys.map((key) => (
                <KeyRow key={key.id} onRevoke={() => setRevoking(key)} row={key} />
              ))}
            </TableBody>
          </Table>
        </TableShell>
      )}

      <CreateKeyDialog
        onClose={() => setCreating(false)}
        onCreated={(created) => {
          setCreating(false);
          setRevealed(created);
          keys.reload();
        }}
        open={creating}
        scopeRoot={scopeRoot}
      />

      <RevealDialog created={revealed} onClose={() => setRevealed(null)} />

      <RevokeDialog
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          keys.reload();
        }}
        target={revoking}
      />
    </>
  );
}

function KeyRow({ row, onRevoke }: { row: ApiKey; onRevoke: () => void }) {
  const revoked = row.revoked_at !== null;
  const expired =
    row.expires_at !== null && Date.parse(row.expires_at) < Date.now();
  const lastUsedAge = ageMs(row.last_used_at);
  /**
   * A key that stopped being used is usually an agent that died, so idleness is
   * surfaced as its own signal rather than left for someone to compute from a
   * timestamp column.
   */
  const idle =
    !revoked && !expired && lastUsedAge !== null && lastUsedAge > SEVEN_DAYS;
  const neverUsed = !revoked && row.last_used_at === null;

  return (
    <TableRow
      className={cn(
        "[&>td:first-child]:border-l-[3px]",
        revoked
          ? "bg-dead/70 text-dead-foreground opacity-75 hover:bg-dead hover:opacity-90 [&>td:first-child]:border-l-dead-foreground/45"
          : "[&>td:first-child]:border-l-transparent",
      )}
    >
      <TableCell>
        <Mono title={row.id}>{row.prefix}</Mono>
      </TableCell>
      <TableCell className="max-w-[16rem]">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{row.label}</span>
          {revoked ? (
            <Badge title={`Revoked ${absoluteTime(row.revoked_at)}`} variant="dead">
              <BanIcon aria-hidden />
              revoked
            </Badge>
          ) : null}
          {expired && !revoked ? (
            <Badge title={`Expired ${absoluteTime(row.expires_at)}`} variant="danger">
              expired
            </Badge>
          ) : null}
          {idle ? (
            <Badge
              title="Not used in over seven days. A key that goes quiet is usually an agent that died."
              variant="muted"
            >
              <MoonIcon aria-hidden />
              idle
            </Badge>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-[18rem]">
        <Mono className="text-muted-foreground" title={row.scope}>
          {row.scope}
        </Mono>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {row.permissions.length === 0 ? (
            <span className="text-muted-foreground text-sm">none</span>
          ) : (
            row.permissions.map((p) => (
              <CodeBadge key={p} variant={p === "admin" ? "purple" : "outline"}>
                {p}
              </CodeBadge>
            ))
          )}
        </div>
      </TableCell>
      <TableCell>
        {row.expires_at === null ? (
          <span className="text-muted-foreground text-sm">never</span>
        ) : (
          <span className="text-sm" title={absoluteTime(row.expires_at)}>
            {relativeTime(row.expires_at) ?? "—"}
          </span>
        )}
      </TableCell>
      <TableCell>
        {neverUsed ? (
          <span className="text-muted-foreground text-sm">never used</span>
        ) : (
          <span className="text-sm" title={absoluteTime(row.last_used_at)}>
            {relativeTime(row.last_used_at) ?? "—"}
          </span>
        )}
      </TableCell>
      <TableCell className="datum-num text-right">{row.use_count}</TableCell>
      <TableCell className="text-right">
        {revoked ? (
          <span className="text-muted-foreground text-sm">—</span>
        ) : (
          <Button onClick={onRevoke} size="sm" variant="outline">
            Revoke
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

const DEFAULT_PERMISSIONS: Permission[] = ["read", "assert"];

function CreateKeyDialog({
  open,
  onClose,
  onCreated,
  scopeRoot,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: CreatedKey) => void;
  scopeRoot: string;
}) {
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState(scopeRoot);
  const [permissions, setPermissions] = useState<Permission[]>(DEFAULT_PERMISSIONS);
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setLabel("");
    setScope(scopeRoot);
    setPermissions(DEFAULT_PERMISSIONS);
    setExpiresAt("");
    setError(null);
    setTouched(false);
  }

  const labelMissing = label.trim().length === 0;
  const scopeMissing = scope.trim().length === 0;
  const permsMissing = permissions.length === 0;
  const blocked = labelMissing || scopeMissing || permsMissing;

  async function submit() {
    setTouched(true);
    if (blocked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await request<CreatedKey>("/admin/api/keys", {
        method: "POST",
        body: {
          label: label.trim(),
          scope: scope.trim(),
          permissions,
          ...(expiresAt === ""
            ? {}
            : { expires_at: new Date(`${expiresAt}T23:59:59Z`).toISOString() }),
        },
      });
      reset();
      onCreated(created);
    } catch (err: unknown) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      description="A key is bound to one scope subtree and one permission set. Neither can be changed later — mint a new key instead."
      dismissable={!submitting}
      footer={
        <>
          <DialogFooterLeft>
            {permsMissing ? "Pick at least one permission." : "Shown once after creation."}
          </DialogFooterLeft>
          <DialogFooterRight>
            <Button disabled={submitting} onClick={onClose} variant="outline">
              Cancel
            </Button>
            <Button disabled={submitting || blocked} onClick={() => void submit()} variant="primary">
              {submitting ? "Creating…" : "Create key"}
            </Button>
          </DialogFooterRight>
        </>
      }
      onClose={() => {
        reset();
        onClose();
      }}
      open={open}
      title="New API key"
    >
      <div className="flex flex-col gap-4">
        <Field>
          <Label htmlFor="key-label">Label</Label>
          <Input
            aria-invalid={(touched && labelMissing) || undefined}
            data-autofocus
            id="key-label"
            onChange={(e) => setLabel(e.target.value)}
            placeholder="arc-bake-worker"
            value={label}
          />
          {touched && labelMissing ? (
            <FieldError>Give the key a label you will recognise in six months.</FieldError>
          ) : (
            <FieldHint>Who or what holds this key.</FieldHint>
          )}
        </Field>

        <Field>
          <Label htmlFor="key-scope">Scope</Label>
          <Input
            aria-invalid={(touched && scopeMissing) || undefined}
            className="font-mono text-[13px]"
            id="key-scope"
            onChange={(e) => setScope(e.target.value)}
            placeholder={scopeRoot}
            value={scope}
          />
          {touched && scopeMissing ? (
            <FieldError>A scope path is required.</FieldError>
          ) : (
            <FieldHint>
              The key may read and write at this path and below it. Defaults to this
              instance&apos;s root.
            </FieldHint>
          )}
        </Field>

        <Field>
          <span className="datum-microlabel">Permissions</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {PERMISSIONS.map((permission) => {
              const checked = permissions.includes(permission);
              return (
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors",
                    checked
                      ? "border-primary/40 bg-primary/5"
                      : "border-input hover:bg-accent",
                  )}
                  key={permission}
                >
                  <input
                    checked={checked}
                    className="mt-0.5 size-4 accent-[var(--primary)]"
                    onChange={(e) =>
                      setPermissions((prev) =>
                        e.target.checked
                          ? [...prev, permission]
                          : prev.filter((p) => p !== permission),
                      )
                    }
                    type="checkbox"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono font-medium text-[13px]">{permission}</span>
                    <span className="text-muted-foreground text-xs leading-snug">
                      {PERMISSION_COPY[permission]}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {touched && permsMissing ? (
            <FieldError>Select at least one permission.</FieldError>
          ) : null}
        </Field>

        <Field>
          <Label htmlFor="key-expiry">Expiry (optional)</Label>
          <Input
            id="key-expiry"
            onChange={(e) => setExpiresAt(e.target.value)}
            type="date"
            value={expiresAt}
          />
          <FieldHint>Leave empty for a key that never expires.</FieldHint>
        </Field>

        {error ? <ErrorState error={error} title="The server refused this key" /> : null}
      </div>
    </Dialog>
  );
}

const PERMISSION_COPY: Record<Permission, string> = {
  read: "Query state, ask, and read missions.",
  assert: "Write new assertions with evidence.",
  supersede: "Retire a live assertion by superseding it.",
  admin: "Manage nodes, missions and scope configuration.",
};

function RevealDialog({
  created,
  onClose,
}: {
  created: CreatedKey | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      description="Copy it now. It is not stored in a form anyone — including this panel — can read back."
      footer={
        <>
          <DialogFooterLeft>
            <Mono className="truncate">{created?.key.prefix}</Mono>
          </DialogFooterLeft>
          <DialogFooterRight>
            <Button onClick={onClose} variant="primary">
              I have copied it
            </Button>
          </DialogFooterRight>
        </>
      }
      onClose={onClose}
      open={created !== null}
      showCloseButton={false}
      title="This is the only time you will see this key"
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <div
            className="flex items-start gap-3 rounded-lg border-[0.5px] border-warning/40 bg-warning/10 px-4 py-3"
            role="alert"
          >
            <TriangleAlertIcon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-warning-foreground"
            />
            <p className="text-sm text-warning-foreground">
              Close this dialog and the secret is gone. If you lose it, revoke this
              key and mint another — there is no recovery path, by design.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="datum-microlabel">Secret</span>
            <div className="flex items-center gap-2">
              <code className="datum-scroll min-w-0 flex-1 overflow-x-auto rounded-md border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] px-3 py-2.5 font-mono text-[13px]">
                {created.secret}
              </code>
              <CopyButton
                className="shrink-0"
                label="Copy"
                size="default"
                value={created.secret}
                variant="outline"
              />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className="datum-microlabel">Label</span>
              <span className="text-sm">{created.key.label}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="datum-microlabel">Scope</span>
              <Mono className="truncate text-muted-foreground">{created.key.scope}</Mono>
            </div>
            <div className="col-span-2 flex flex-col gap-1">
              <span className="datum-microlabel">Permissions</span>
              <span className="flex flex-wrap gap-1">
                {created.key.permissions.map((p) => (
                  <CodeBadge key={p} variant={p === "admin" ? "purple" : "outline"}>
                    {p}
                  </CodeBadge>
                ))}
              </span>
            </div>
          </dl>
        </div>
      ) : null}
    </Dialog>
  );
}

function RevokeDialog({
  target,
  onClose,
  onRevoked,
}: {
  target: ApiKey | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function revoke() {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await request<void>(`/admin/api/keys/${encodeURIComponent(target.id)}/revoke`, {
        method: "POST",
      });
      toast.push({
        tone: "success",
        title: "Key revoked",
        body: `${target.prefix} — ${target.label} can no longer authenticate.`,
      });
      onRevoked();
    } catch (err: unknown) {
      setError(toApiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      description="Revoking takes effect immediately. Assertions this key already wrote stay in the record — nothing in this store is ever deleted."
      dismissable={!submitting}
      footer={
        <>
          <DialogFooterLeft>
            {target ? <Mono className="truncate">{target.prefix}</Mono> : null}
          </DialogFooterLeft>
          <DialogFooterRight>
            <Button disabled={submitting} onClick={onClose} variant="outline">
              Keep it
            </Button>
            <Button
              data-autofocus
              disabled={submitting}
              onClick={() => void revoke()}
              variant="destructive"
            >
              {submitting ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooterRight>
        </>
      }
      onClose={() => {
        setError(null);
        onClose();
      }}
      open={target !== null}
      title={`Revoke ${target?.label ?? "key"}?`}
    >
      {target ? (
        <div className="flex flex-col gap-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <span className="datum-microlabel">Scope</span>
              <Mono className="truncate text-muted-foreground">{target.scope}</Mono>
            </div>
            <div className="flex flex-col gap-1">
              <span className="datum-microlabel">Uses</span>
              <span className="datum-num text-sm">{target.use_count}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="datum-microlabel">Last used</span>
              <span className="text-sm">
                {relativeTime(target.last_used_at) ?? "never"}
              </span>
            </div>
          </dl>
          {error ? <ErrorState error={error} title="Revoke failed" /> : null}
        </div>
      ) : null}
    </Dialog>
  );
}
