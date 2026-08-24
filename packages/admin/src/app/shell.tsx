import {
  CircleAlertIcon,
  DatabaseIcon,
  FolderTreeIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  ScrollTextIcon,
  ServerIcon,
  ShieldCheckIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { href } from "../lib/router";
import type { Me } from "../lib/types";
import { Button } from "../ui/button";
import { Mono } from "../ui/primitives";
import { useSession } from "./session";

export interface NavEntry {
  label: string;
  path: string;
  icon: LucideIcon;
}

export const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "The record",
    items: [
      { label: "Overview", path: "/", icon: LayoutDashboardIcon },
      { label: "Assertions", path: "/assertions", icon: DatabaseIcon },
      { label: "Contradictions", path: "/contradictions", icon: CircleAlertIcon },
      { label: "Missions", path: "/missions", icon: TargetIcon },
      { label: "Scopes", path: "/scopes", icon: FolderTreeIcon },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Keys", path: "/keys", icon: KeyRoundIcon },
      { label: "Rejected writes", path: "/rejections", icon: ScrollTextIcon },
      { label: "Nodes", path: "/nodes", icon: ServerIcon },
    ],
  },
];

function isActive(current: string, path: string): boolean {
  if (path === "/") return current === "/";
  return current === path || current.startsWith(`${path}/`);
}

/**
 * Layout is echos_app's `app/(main)/layout.tsx` shape: an 18rem sidebar on the
 * `--sidebar` surface with a 3rem header row, and the content as an inset card
 * (`SidebarInset`: `m-2 ml-0 rounded-xl border border-sidebar-border
 * bg-background`, `h-[calc(100svh-1rem)]`, its own scroll container). The nav
 * button treatment — `rounded-sm p-2.5 font-medium text-sm`,
 * `hover:bg-muted-foreground/10`, and the active state's bordered
 * `bg-sidebar-accent` card with echos's exact shadow tuple and `!text-primary`
 * icon — is copied from `sidebarMenuButtonVariants`.
 */
export function Shell({
  me,
  currentPath,
  title,
  children,
}: {
  me: Me;
  currentPath: string;
  title: string;
  children: ReactNode;
}) {
  const { signOut } = useSession();

  return (
    <div
      className="flex min-h-svh w-full bg-sidebar text-sidebar-foreground"
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <aside className="sticky top-0 hidden h-svh w-(--sidebar-width) shrink-0 flex-col md:flex">
        <div className="flex h-(--header-height) items-center gap-2.5 px-4">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheckIcon aria-hidden className="size-4" />
          </span>
          <span className="flex min-w-0 flex-col leading-none">
            <span className="font-semibold text-[15px] text-foreground">Datum</span>
            <Mono className="truncate text-[11px] text-muted-foreground">
              {me.scope_root}
            </Mono>
          </span>
        </div>

        <nav
          aria-label="Sections"
          className="datum-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-2"
        >
          {NAV_GROUPS.map((group) => (
            <div className="flex flex-col gap-1 px-2" key={group.label}>
              <div className="flex h-8 shrink-0 items-center font-normal text-neutral-600 text-sm">
                {group.label}
              </div>
              <ul className="flex w-full min-w-0 flex-col gap-0.5">
                {group.items.map((item) => {
                  const active = isActive(currentPath, item.path);
                  return (
                    <li key={item.path}>
                      <a
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex w-full items-center gap-2.5 overflow-hidden rounded-sm p-2.5 text-left font-medium text-sm outline-hidden transition-[width,height,padding] focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                          "hover:bg-muted-foreground/10 hover:text-sidebar-accent-foreground",
                          active &&
                            "rounded-md border border-border bg-sidebar-accent text-foreground shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1)]",
                        )}
                        data-active={active}
                        href={href(item.path)}
                      >
                        <item.icon
                          aria-hidden
                          className={cn(
                            "size-4 shrink-0",
                            active ? "text-primary" : "text-neutral-500",
                          )}
                        />
                        <span className="truncate">{item.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="relative flex flex-col gap-2 px-4 pb-4">
          <div className="pointer-events-none absolute inset-x-0 -top-16 h-16 bg-linear-to-b from-transparent to-sidebar" />
          <div className="flex flex-col gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/60 p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="datum-microlabel">org</span>
              <Mono className="truncate text-[12px]">{me.org}</Mono>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="datum-microlabel">postgres</span>
              <Mono className="text-[12px]">{me.postgres}</Mono>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="datum-microlabel">verification</span>
              <Mono
                className={cn(
                  "text-[12px]",
                  me.verification.configured ? "text-success" : "text-muted-foreground",
                )}
                title={
                  me.verification.configured
                    ? `Checker: ${me.verification.method}. Unverified rows can be promoted to measured.`
                    : "No checker configured on this instance, so nothing can be promoted to measured."
                }
              >
                {me.verification.configured ? me.verification.method : "not configured"}
              </Mono>
            </div>
          </div>
          <Button
            className="justify-start px-2.5"
            onClick={() => void signOut()}
            size="sm"
            variant="ghost"
          >
            <LogOutIcon />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="relative m-0 flex min-w-0 w-full flex-1 flex-col bg-background md:m-2 md:ml-0 md:h-[calc(100svh-1rem)] md:overflow-y-auto md:rounded-xl md:border md:border-sidebar-border">
        <header className="sticky top-0 z-40 flex h-(--header-height) shrink-0 items-center justify-between gap-4 border-b border-b-[0.5px] border-b-[#E5E5E5] bg-background/95 px-6 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-sm">{title}</span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="flex items-baseline gap-1.5"
              title="Current write sequence. Every assertion is stamped with one of these, and the as-of control rewinds against it."
            >
              <span className="datum-microlabel">sequence</span>
              <Mono className="text-[13px] text-foreground">{me.sequence}</Mono>
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">{children}</div>
      </main>
    </div>
  );
}

/** Mobile nav: the sidebar is hidden below md, so surface the links inline. */
export function MobileNav({ currentPath }: { currentPath: string }) {
  return (
    <nav
      aria-label="Sections"
      className="datum-scroll -mx-6 flex gap-1 overflow-x-auto px-6 pb-1 md:hidden"
    >
      {NAV_GROUPS.flatMap((g) => g.items).map((item) => {
        const active = isActive(currentPath, item.path);
        return (
          <a
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 font-medium text-sm transition-colors",
              active
                ? "border border-border bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
            href={href(item.path)}
            key={item.path}
          >
            <item.icon aria-hidden className="size-4" />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
