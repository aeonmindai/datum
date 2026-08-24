import {
  CircleAlertIcon,
  DatabaseIcon,
  FolderTreeIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MoonIcon,
  ScrollTextIcon,
  ServerIcon,
  ShieldCheckIcon,
  SunIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
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

const THEME_KEY = "datum-theme";

function isActive(current: string, path: string): boolean {
  if (path === "/") return current === "/";
  return current === path || current.startsWith(`${path}/`);
}

/**
 * Theme state. index.html applies the class before first paint so a dark-mode
 * operator never sees a white flash; this hook only reflects and mutates it.
 * An explicit choice is sticky. With no stored choice the OS keeps control, so
 * a system theme switch is followed live rather than only on reload.
 */
function useTheme(): ["light" | "dark", () => void] {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      return;
    }
    if (stored === "light" || stored === "dark") return;

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = (event: MediaQueryListEvent | MediaQueryList) => {
      document.documentElement.classList.toggle("dark", event.matches);
      setTheme(event.matches ? "dark" : "light");
    };
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // Private mode: the choice holds for this tab and no longer.
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

/**
 * Layout is runcrate_app's `src/components/dashboard-layout.tsx` shape:
 * `SidebarProvider` (a `bg-sidebar flex h-svh w-full` wrapper carrying
 * `--sidebar-width: 16rem`), a `variant="inset"` sidebar in its own `p-3`
 * gutter, and `SidebarInset` — `bg-background relative flex w-full flex-1
 * flex-col overflow-hidden md:m-3 md:ml-0 md:rounded-xl md:border
 * md:border-edge-subtle`. Content sits in the scroll container at
 * `p-8 pb-10 lg:p-10 lg:pb-12`, exactly as runcrate pads it.
 *
 * The header row is `src/components/dashboard-header.tsx`: `flex h-11
 * items-center gap-3 px-4 lg:px-6 flex-shrink-0 border-b border-edge-subtle`,
 * label on the left, `ml-auto` actions on the right, `h-4 w-px bg-edge-subtle`
 * hairlines between groups, and the rounded-full `border border-edge` pill for
 * a live monospace figure — which is what the write sequence is.
 *
 * Nav rows use the shipped `sidebarMenuButtonVariants` from
 * `src/components/ui/sidebar.tsx`, not the bespoke `nav-items.tsx` override:
 * that override draws its active pill in `bg-background` on a `bg-sidebar`
 * parent, and since `--sidebar` is defined equal to `--background` the pill is
 * the same colour as what is behind it. The primitive's
 * `data-[active=true]:bg-sidebar-accent` is a real step off the surface.
 * Group labels are the screen idiom from `nav-items.tsx` — `text-2xs
 * font-semibold text-muted-foreground/50 uppercase tracking-widest`.
 *
 * There is no collapse toggle. runcrate's sidebar collapses to an icon rail;
 * adding that here would be new behaviour, and this is a restyle.
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
  const [theme, toggleTheme] = useTheme();

  return (
    <div
      className="flex h-svh w-full bg-sidebar text-sidebar-foreground"
      data-slot="sidebar-wrapper"
      style={{ "--sidebar-width": "16rem" } as React.CSSProperties}
    >
      <aside className="hidden w-(--sidebar-width) shrink-0 p-3 md:flex">
        <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 p-2">
            <div className="flex items-center gap-2.5 overflow-hidden px-2 py-1">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ShieldCheckIcon aria-hidden className="size-3.5" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-semibold text-lg leading-5 text-sidebar-foreground">
                  Datum
                </span>
                <Mono className="truncate text-2xs text-muted-foreground">
                  {me.scope_root}
                </Mono>
              </span>
            </div>
          </div>

          <nav
            aria-label="Sections"
            className="scrollbar-hide flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
          >
            {NAV_GROUPS.map((group) => (
              <div
                className="relative flex w-full min-w-0 flex-col p-2"
                key={group.label}
              >
                <div className="flex h-8 shrink-0 items-center px-2 font-semibold text-2xs text-muted-foreground/50 uppercase tracking-widest">
                  {group.label}
                </div>
                <ul className="flex w-full min-w-0 flex-col gap-1">
                  {group.items.map((item) => {
                    const active = isActive(currentPath, item.path);
                    return (
                      <li key={item.path}>
                        <a
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[background-color,color] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
                            "data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground",
                          )}
                          data-active={active}
                          href={href(item.path)}
                        >
                          <item.icon aria-hidden className="text-muted-foreground" />
                          <span>{item.label}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="flex flex-col gap-2 p-2">
            <div className="flex flex-col gap-1 rounded-lg border border-edge-subtle px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="datum-microlabel">org</span>
                <Mono className="truncate text-xs">{me.org}</Mono>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="datum-microlabel">postgres</span>
                <Mono className="text-xs">{me.postgres}</Mono>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="datum-microlabel">checker</span>
                <Mono
                  className={cn(
                    "truncate text-xs",
                    me.verification.configured
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                  title={me.verification.note}
                >
                  {me.verification.configured
                    ? me.verification.method
                    : "not configured"}
                </Mono>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                className="flex-1 justify-start px-2"
                onClick={() => void signOut()}
                size="sm"
                variant="ghost"
              >
                <LogOutIcon />
                Sign out
              </Button>
              <Button
                aria-label={
                  theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
                }
                onClick={toggleTheme}
                size="iconSm"
                title={
                  theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
                }
                variant="ghost"
              >
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </Button>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative flex w-full min-w-0 flex-1 flex-col overflow-hidden bg-background md:m-3 md:ml-0 md:rounded-xl md:border md:border-edge-subtle">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge-subtle px-4 lg:px-6">
          <span className="truncate font-medium text-sm">{title}</span>
          <div className="ml-auto flex items-center gap-3">
            <div
              className="flex h-7 items-center overflow-hidden rounded-full border border-edge"
              title="Current write sequence. Every assertion is stamped with one of these, and the as-of control rewinds against it."
            >
              <span className="px-3 font-medium text-2xs text-muted-foreground uppercase tracking-wider">
                seq
              </span>
              <span className="h-full w-px bg-edge" />
              <span className="datum-num px-3 font-medium font-mono text-sm text-foreground/70">
                {me.sequence}
              </span>
            </div>
            <span className="h-4 w-px bg-edge-subtle md:hidden" />
            <Button
              aria-label={
                theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
              }
              className="md:hidden"
              onClick={toggleTheme}
              size="iconSm"
              variant="ghost"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </Button>
          </div>
        </header>

        <div
          className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-8 pb-10 lg:p-10 lg:pb-12"
          data-slot="scroll-container"
        >
          <div className="flex min-h-full min-w-0 max-w-full flex-col gap-6">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Mobile nav: the sidebar is hidden below md, so surface the links inline. */
export function MobileNav({ currentPath }: { currentPath: string }) {
  return (
    <nav
      aria-label="Sections"
      className="scrollbar-hide -mx-8 flex shrink-0 gap-1 overflow-x-auto px-8 md:hidden"
    >
      {NAV_GROUPS.flatMap((g) => g.items).map((item) => {
        const active = isActive(currentPath, item.path);
        return (
          <a
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 font-medium text-sm transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
