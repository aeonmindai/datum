# Design notes

The admin panel is styled from **`runcrate_app`**. This file records exactly what
was copied, what was deliberately changed, and why — specifically enough that a
reader can tell a port from a drift.

An earlier version of this panel was styled from `echos_app` (Outfit, an OKLCH
purple palette, a five-colour semantic ramp, a recessed `--dead` surface). That
is gone. No token, class string or component in `src/` descends from it.

---

## 1. What was read, and what came from where

Every file below was read from `/Users/jish/Documents/GitHub/runcrate_app`
(read-only; nothing in that repo was modified).

| runcrate source | What was taken |
| --- | --- |
| `src/styles/globals.css` — `:root` (lines 87–152), `.dark` (165–227) | Every colour triplet, verbatim, including the explanatory comments. They document a real hierarchy (`bg === surface → muted → surface-hover`, `edge-subtle → edge → border`) and the next reader needs them. |
| `src/styles/globals.css` — `body` rule (251–258) | `font-family`, `font-weight: 400`, `font-synthesis: none`, `font-feature-settings: 'kern' 1, 'liga' 1, 'calt' 1, 'case' 1, 'cpsp' 1`, `letter-spacing: -0.011em`, plus `h1..h6 { text-rendering: optimizeLegibility }`. |
| `src/styles/globals.css` — 32–68, 265–291, 7–15 | The 6px auto-fading scrollbar, the Firefox `scrollbar-width: thin`, the `100dvh`/`overflow: hidden` viewport lock, the inset 8px scroll-container scrollbar, `.scrollbar-hide`. |
| `tailwind.config.js` — `fontSize` (57–64) | The **entire** type ramp, not just `2xs`. `2xs .6875 / xs .78125 / sm .84375 / base .9375 / lg 1.03125 / xl 1.15625 rem` with paired line heights. Every one is smaller than the framework default; this is most of why the interface reads dense and precise. `2xl` and above are **not** overridden — runcrate does not override them either. |
| `tailwind.config.js` — `borderRadius` (65–69) | `--radius: 0.75rem`, `lg: var(--radius)`, `md: calc(--radius - 2px)`, `sm: calc(--radius - 4px)`. `rounded-lg` is 12px here, not the framework's 8px. `xl`/`2xl` are untouched, which is why buttons (`rounded-xl`) read slightly rounder than a card's internals. |
| `tailwind.config.js` — `colors` (70–138) | `surface`/`surface-hover`, `edge`/`edge-subtle`, `brand`/`brand-dim`, `input-bg`, `overlay` and the `sidebar-*` family as real Tailwind colours, not raw vars. `edge`/`edge-subtle` are a visibly softer tier than `border` and are what internal dividers use. |
| `tailwind.config.js` — `boxShadow` (12–16) | `shadow-card`, `shadow-floating`, `shadow-hero` mapped to per-theme values. |
| `src/pages/_app.tsx` (15–40) | Font wiring: Geist for sans, JetBrains Mono for mono. |
| `src/components/ui/button.tsx` | Base string and all six variants and four sizes, verbatim. |
| `src/components/ui/card.tsx` | `rounded-2xl border border-border/60 py-6 gap-6`, `px-6` sub-slots, `leading-none font-semibold` title, and **no shadow**. |
| `src/components/ui/badge.tsx` | Base string and all four variants, verbatim. |
| `src/components/ui/table.tsx` | Row `hover:bg-muted/50 transition-colors`, head cell `h-10 text-left align-middle font-medium whitespace-nowrap`, container `relative w-full overflow-x-auto`. |
| `src/components/ui/input.tsx`, `textarea.tsx`, `label.tsx` | Field treatment `rounded-xl border border-input bg-input-bg px-3.5 py-2 text-base md:text-sm` + `focus:border-ring` + `aria-invalid:border-destructive`. |
| `src/components/ui/select.tsx` | The `SelectTrigger` class string and its `h-10`/`h-8` sizes. |
| `src/components/ui/dialog.tsx` | Overlay `bg-overlay`, panel `rounded-2xl border border-border/60 bg-background p-6 shadow-xl sm:max-w-lg`, header/title/description/close-button treatments. |
| `src/components/ui/dropdown-menu.tsx` | Content `bg-popover rounded-xl border border-border/60 p-1 shadow-lg`, items `rounded-lg px-2 py-1.5 text-sm`, destructive items, separator. |
| `src/components/ui/tabs.tsx` | List `bg-muted rounded-xl h-10 p-1`, trigger `rounded-lg px-3 py-1.5`, selected `bg-background text-foreground shadow-sm`. |
| `src/components/ui/skeleton.tsx` | `bg-accent animate-pulse rounded-md`, verbatim. |
| `src/components/ui/separator.tsx` | Used as the inline `h-4 w-px bg-edge-subtle` hairline idiom rather than as a component. |
| `src/components/ui/hover-card.tsx` | `bg-popover rounded-md border p-4 shadow-md`. |
| `src/components/ui/alert.tsx` | Base, `default` and `destructive` variants; the title and description treatments. |
| `src/components/ui/sidebar.tsx` | `SIDEBAR_WIDTH = 16rem`, `SIDEBAR_WIDTH_ICON = 3rem`; `SidebarInset`'s inset variant; `SidebarHeader`/`Footer`/`Content`/`Group` paddings; `sidebarMenuButtonVariants`. |
| `src/components/ui/sonner.tsx` | Toast surface `bg-surface border border-edge`, title `text-foreground`, body `text-muted-foreground`. |
| `src/components/dashboard-layout.tsx` | The shell: sidebar + inset content, `p-8 pb-10 lg:p-10 lg:pb-12` on the scroll container. |
| `src/components/dashboard-header.tsx` | `flex h-11 items-center gap-3 px-4 lg:px-6 border-b border-edge-subtle`, `ml-auto` actions, `h-4 w-px bg-edge-subtle` dividers, and the `h-7 rounded-full border border-edge` pill for a live monospace figure. |
| `src/components/nav-items.tsx` | Group label `text-2xs font-semibold text-muted-foreground/50 uppercase tracking-widest`; nav row height `h-9`/`text-[13.5px]` (= `text-sm`). |
| `src/pages/dashboard/audit-log.tsx` | The dense data-table idiom: container `rounded-xl border border-edge bg-surface overflow-hidden`, toolbar/footbar strips `px-5 py-3 border-*-edge-subtle`, header cells `px-5 py-3 text-2xs font-medium text-muted-foreground uppercase tracking-wider`, body cells `px-5 py-3.5`. Also the page-header idiom (`h1.text-xl.font-medium` + `text-muted-foreground text-sm mt-1`) and the empty-state idiom. |
| `src/pages/dashboard/api-keys.tsx` | Confirmed the same table idiom is used across screens, not one-off. |

### The surface philosophy, restated because it is load-bearing

Page background **is** the card surface: `--surface` and `--sidebar` are both
defined equal to `--background` in both themes. A card is therefore defined by
its outline, not by contrast — it reads as cut into the page rather than
floating on it. `Card` in this panel has **no shadow** for exactly that reason.
Adding elevation the original does not have is the fastest way to make a port
look like a copy.

---

## 2. Confidence classes: the one real design problem, and how it was resolved

runcrate's palette is pure neutral grey with exactly **two** chromatic tokens:
`--ring` (`217 91% 60%`, blue, used only for focus) and `--destructive`
(`0 72% 51%`, red, used only for alarm). There is no green, no amber and no
second blue to spend on a four-class semantic ramp, and inventing three would
not be a restyle.

So the ranking is carried by **fill weight, border style, icon and monospace
labelling** instead of hue. This replaces the previous green / purple / blue /
amber ramp entirely.

| Confidence | Badge | Icon | Reading |
| --- | --- | --- | --- |
| `measured` | `default` — solid, inverted | `CircleCheckIcon` | Strongest. The only class a gate will read. |
| `confirmed-by-human` | `secondary` — grey fill | `UserCheckIcon` | Testimony, not an instrument. |
| `derived` | `outline` | `GitBranchIcon` | Computed from other rows. |
| `unverified` | `outline` + dashed border + `text-muted-foreground` | `ClockIcon` | Normal, and **not** an error. |

Weight decreases exactly as authority decreases, so a column of these reads as
a ranking at a glance. It also survives greyscale, colour-blindness and a
printed screenshot, which a hue ramp does not.

`unverified` is dashed rather than red on purpose: no agent may write
`measured`, so every honest agent write starts at `unverified`.

### Where red is allowed

Red is reserved. It is a **solid `destructive` fill** on exactly three things:

- a **refuted** verification (`ShieldAlertIcon`, plus a full-strength
  `border-destructive` banner on the detail screen — this one is loud);
- a **rejected** write (every reason chip and row spine in `/rejections`);
- `kind: dead` and `kind: failed`.

It appears as an **edge and text tint only** (`BADGE_ALARM` =
`border-destructive/50 text-destructive`) on states that are a genuine problem
but not a refusal: a **contested** row, an open contradiction, a derived row
whose inputs no longer resolve, an expired key, a blocked mission, a missed
gate.

### Retired versus contested

Both are row-level treatments, and they must not be confusable:

- **Superseded / revoked / `kind: dead`** → `bg-muted/50 text-muted-foreground
  opacity-75` with a left `border-l-2 border-border` spine and a `secondary`
  badge in `text-muted-foreground`. Recession, not alarm — the row is retired,
  not broken. **No strikethrough**: strikethrough reads as "edited" and this
  store never edits.
- **Contested** → the same left `border-l-2` spine in `border-destructive/50`
  plus a destructive-outline badge, because two live rows disagreeing genuinely
  is a problem and the store refuses to pick one for you.

### Three named compositions

Because these treatments appear on eight screens, they are named once in
`src/ui/badge.tsx` rather than retyped:

- `BADGE_PENDING` = `border-dashed text-muted-foreground` — not-yet-known, and
  that is fine (`unverified`, an unresolvable check, a gate with no qualifying
  evidence, an isolated take).
- `BADGE_ALARM` = `border-destructive/50 text-destructive` — a real problem
  that is not a refusal.
- `BADGE_RETIRED` = `text-muted-foreground` — kept in the record, excluded from
  every default read.

They are class strings, not new `Badge` variants, because they are *states*:
each is an `outline` or `secondary` badge with its border style or text weight
adjusted. `Badge` itself ships exactly runcrate's four variants and no more.

### Other places hue used to do the work

| Was | Now |
| --- | --- |
| `text-success` / `text-warning` / `text-info` on verification standing | Only `ok` gets `text-foreground`; everything else is `text-muted-foreground`. The distinction that matters is settled-vs-not-settled, and contrast carries it. |
| Green/red timeline dots in the supersession chain | Live head is `border-foreground` + a filled `bg-foreground` dot; superseded is `border-border`, hollow. |
| Green "reached" / amber "no qualifying evidence" gate pills | `reached` is a solid `bg-primary` pill; `not reached` is a destructive-edge pill; `unknown` is a dashed, recessed pill. `unknown` is deliberately the quietest of the three — it is the absence of a reading, not a failure. |
| Amber login lockout banner | `border-border/60 bg-muted/50` with a muted icon. A rate limiter doing its job is not an error. |
| Amber "copy this secret now" warning in the key dialog | Same recessed treatment. It is an instruction, not a failure. |
| Green/amber `--dead` recessed surface | `bg-muted/50` + `opacity-75`, which is the same idea using tokens that already exist. |
| Purple `admin` permission / `root` scope chips | `default` (solid) — the privileged value is the strongest one, which is what solid means here. |
| Green/red heartbeat spine in `/nodes` | Live is `border-l-foreground/40`; stale is `border-l-edge-subtle`. Staleness is a hint, not a fault, so it does not earn the destructive edge. |

---

## 3. Deliberate divergences from runcrate

Each of these is a structural constraint of this package, not a taste call.

1. **Tailwind v4, not v3.** runcrate is v3 with `hsl(var(--x))` triplets in
   `tailwind.config.js`. This package is v4 (`@import "tailwindcss"` +
   `@tailwindcss/vite`) and must stay there. The triplets and the class strings
   are identical; only the plumbing differs — `colors: { x: 'hsl(var(--x)) }`
   becomes `@theme inline { --color-x: hsl(var(--x)) }`. `inline` is what makes
   the `.dark` override reach the utility. Verified in the built CSS: opacity
   modifiers compile to `color-mix(in oklab, hsl(var(--muted)) 50%, transparent)`
   with an `hsl(var(--muted))` fallback, so `bg-muted/50`, `border-border/60`
   and `ring-ring/40` behave exactly as in runcrate.
2. **`darkMode: ['class']` → `@custom-variant dark (&:is(.dark *))`.** Same
   semantics, v4 syntax.
3. **`--shadow-card|floating|hero` are stored as `--elevation-*`.** In v4,
   `--shadow-*` *is* the theme namespace, so keeping runcrate's variable names
   would make `@theme` self-referential. The values are byte-identical; only the
   source variable is renamed.
4. **Google Fonts `<link>`, not `next/font`.** There is no `next/font` in a Vite
   SPA. `index.html` loads `family=Geist:wght@100..900` and
   `family=JetBrains+Mono:wght@400;500;600`; both degrade to the system stacks
   declared in `index.css`, which is what an air-gapped self-hosted instance
   renders. Verified in a browser: `document.fonts.check` is true for both.
   runcrate's `--font-satoshi` logo wordmark is not ported — there is no
   Satoshi licence or file here, and the wordmark is set in Geist.
5. **Hand-rolled primitives, no Radix, no cva, no `tailwindcss-animate`.** The
   package deliberately has none of those and keeps none. Variant maps are plain
   records looked up through `cn` (`src/lib/cn.ts`), `asChild` is replaced by a
   `LinkButton` that renders a real `<a>` (the hash router navigates through
   links), and the four enter animations `tailwindcss-animate` would have
   supplied are written out as keyframes at the bottom of `index.css` at
   runcrate's own 200ms/ease-out. All existing focus-trap, click-outside,
   Escape, scroll-lock and ARIA behaviour is unchanged — only classes moved.
6. **`iconSm` button size added** (`h-8 w-8 rounded-lg`). runcrate reaches for
   `size="icon" className="size-7"` in its own header and sidebar trigger; a
   dense admin table needs that shape often enough to name it.
7. **`muted` alert variant added** (`border-border/60 bg-muted/50
   text-muted-foreground`). runcrate's alert ships only neutral and alarm, and
   this product has several notices that are neither — the banner over a retired
   row, a check that could not resolve, "copy this secret now".
8. **Table dividers sit on the cells, not on `<tr>`.** All four data tables use
   a sticky header, which needs `border-separate border-spacing-0` to keep its
   border while scrolling; in the separated-borders model a `<tr>` cannot paint a
   border at all. Same hairlines, same `border-edge-subtle` tier, one level down
   the tree. This is also what lets a row carry the `border-l-2` retired /
   contested spine.
9. **No sidebar collapse.** runcrate's sidebar collapses to a 3rem icon rail.
   Adding that here would be new behaviour, and this is a restyle. `16rem` is
   fixed; the sidebar is simply hidden below `md`, where `MobileNav` takes over.
10. **`[data-slot="scroll-container"]`, not `[data-tour="welcome"]`.** runcrate
    hangs its thin inset scrollbar off a product-tour hook. The rules are
    identical; the selector is renamed to what it actually is. The viewport lock
    keeps runcrate's own `[data-slot="sidebar-wrapper"]` selector, which means
    `/login` and the 404 — which do not mount the shell — still scroll normally.

### Two runcrate details deliberately *not* reproduced

- **`DialogContent`'s `style={{ fontFamily: 'var(--font-figtree), system-ui,
  sans-serif' }}`.** `--font-figtree` is not defined anywhere in runcrate, so
  that declaration falls through to `system-ui` and runcrate's dialogs are the
  only surface in the app not set in Geist. That is a bug, and copying it would
  make this panel inconsistent with itself.
- **`nav-items.tsx`'s active pill and `audit-log.tsx`'s row hover.** The pill is
  `bg-background` on a `bg-sidebar` parent and row hover is `hover:bg-surface`
  inside a `bg-surface` container — and since `--sidebar` and `--surface` are
  both defined equal to `--background`, both are the same colour as what is
  behind them and read as nothing. The shipped primitives are used instead:
  `data-[active=true]:bg-sidebar-accent` from `sidebarMenuButtonVariants`, and
  `hover:bg-muted/50` from `ui/table.tsx`. Both are runcrate's own code and both
  actually register.
- runcrate spells two of its own boxes with raw palette literals
  (`border-red-500/20 bg-red-950/20 text-red-400` for the audit-log error box;
  `bg-red-50 / bg-green-50 / bg-yellow-50` for per-tone Sonner toasts). Those
  are outside the token set and only resolve legibly in one theme. The
  token-correct equivalents from runcrate's own `alert.tsx` and base Sonner
  surface are used instead.

---

## 4. Dark mode

`darkMode: ['class']` is ported as `@custom-variant dark`, and both themes ship.
`index.html` applies the class **before first paint** so a dark-mode operator
never sees a white flash: an explicit choice in `localStorage["datum-theme"]`
wins, otherwise `prefers-color-scheme` decides. With no explicit choice stored,
a live OS theme change is followed (a `matchMedia` listener in `useTheme`); once
the operator picks, the choice is sticky. The toggle is in the sidebar footer,
with a `md:hidden` duplicate in the header row for the mobile layout where the
sidebar is not rendered.

Dark is where this palette looks best and it was verified in a browser at
1440×900: `background` resolves to `rgb(18,18,18)` and `foreground` to
`rgb(235,235,235)` — runcrate's `#121212` / `#ebebeb` exactly.

---

## 5. Verification performed

Against a real server (`datum serve` on a seeded Postgres), not fixtures:

- `npx tsc -b --noEmit` — clean.
- `npx vite build` — succeeds, writes to `packages/datum/public/admin`.
- No Outfit, no OKLCH and no `#E5E5E5`/`#FAFAFA`/`neutral-*` literals anywhere
  in `src/`.
- No new dependencies in `package.json`.
- All ten routes plus the styled 404 render in both themes at 1440px, with real
  loading (skeleton), empty and error states exercised on each.
- `scrollWidth === clientWidth` on every data table (`/assertions`, `/keys`,
  `/rejections`, `/nodes`) and no horizontal overflow on the page scroll
  container on any route. `/assertions` needed its truncating columns tightened
  by 2rem each to reach this; every one of those cells already carried a `title`,
  so nothing became unreadable.
- Dialogs, the reveal/revoke flow, the toast queue and the provenance hover-card
  (opened by keyboard focus) all render and behave as before.
