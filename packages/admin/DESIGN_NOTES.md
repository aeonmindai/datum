# Design notes — where the admin panel's look comes from

The brief for this panel was: adopt `echos_app`'s **actual** design language, do not invent a
visual system, and write down what was taken so the next person can tell inspiration from drift.
This file is that record. `echos_app` is
`~/Documents/GitHub/echos-backend/apps/frontend`; it was read-only throughout and nothing in it
was modified.

Every path below is a real file that was opened and copied from.

---

## 1. Taken verbatim

### Design tokens — `app/globals.css` → `src/index.css`

The entire `:root` block (echos lines 8–67), the entire `.dark` block (lines 69–119) and the whole
`@theme inline` mapping (lines 121–177) were copied character-for-character. That includes every
OKLCH colour, the `hsla()` ones echos uses for `--muted-foreground` / `--border` / `--input` /
`--ring`, all eight shadow tuples, `--radius: 0.7rem`, `--spacing: 0.25rem` and
`--tracking-normal`.

Load-bearing consequences that came along with the copy:

- `--primary: oklch(0.5257 0.2464 282.95)` — echos's purple. It is the app's only accent.
- `--ring: hsla(252, 86%, 59%, 1)` — the purple-blue focus ring, not a browser default.
- The `@theme inline` block **redefines** `--radius-sm/md/lg/xl` from `--radius`. So `rounded-md`
  here is `calc(0.7rem - 2px)` ≈ 9.2px, **not** Tailwind's stock 6px. Keeping that override is why
  the controls have the same slightly-soft corner as echos. (The extraction report said
  `rounded-md` was 0.375rem; reading `globals.css` directly showed otherwise. The file won.)
- `@layer base` carries echos's `* { @apply border-border outline-ring/50 }` and its body font
  rendering rules — `-webkit-font-smoothing: antialiased`, `text-rendering: optimizeLegibility`,
  `font-feature-settings: 'liga' 1, 'kern' 1`.

### Component class strings

| this repo | copied from | what was taken |
|---|---|---|
| `src/lib/cn.ts` | `lib/utils.ts` | `twMerge(clsx(inputs))`, unchanged |
| `src/ui/button.tsx` | `components/ui/button.tsx` | the full base string, and the `default`/`outline`/`secondary`/`ghost`/`link`/`destructive` variants; sizes `h-10` / `h-8` / `h-12` / `size-10` including the `has-[>svg]:px-*` tweaks |
| `src/ui/card.tsx` | `components/ui/card.tsx` | `rounded-xl border bg-card py-6 gap-6 shadow-sm`, `px-6` on every sub-slot, the `has-data-[slot=card-action]` two-column header, `[.border-t]:pt-6` |
| `src/ui/table.tsx` | `components/ui/table.tsx` | `border-separate border-spacing-0`, the `#FAFAFA` header with `#404040` text, `h-11` header cells, `hover:bg-muted/50` rows, `border-r-[0.5px] border-r-[#E5E5E5] last:border-r-0` cell hairlines, and the `sticky` header prop with its `z-30` comment intact |
| `src/ui/badge.tsx` | `components/ui/badge.tsx` | the base string and the `default`/`secondary`/`destructive`/`outline` variants |
| `src/ui/input.tsx` | `components/ui/input.tsx`, `label.tsx`, `form.tsx` | `h-10 rounded-md border-input px-3 py-1`, `focus-visible:ring-[3px] ring-ring/50`, `aria-invalid:border-destructive aria-invalid:ring-destructive/20`, the `suffix` slot with `pr-10`; `Label`'s string; `FormItem` → `Field` (`grid gap-2`), `FormDescription` → `FieldHint`, `FormMessage` → `FieldError` |
| `src/ui/dialog.tsx` | `components/ui/dialog.tsx` | overlay `bg-black/50 backdrop-blur-xs`, panel `rounded-2xl border-[0.5px] border-neutral-200 bg-white p-6 sm:max-w-lg`, title `font-semibold text-xl leading-tight`, description `text-muted-foreground text-sm leading-relaxed`, close button at `top-4 right-4` with `hover:scale-110`, footer `border-t pt-4` plus the `DialogFooterLeft` / `DialogFooterRight` split |
| `src/ui/tabs.tsx` | `components/ui/animated-tabs.tsx` | the whole sliding-indicator idea and its classes: list `h-10 gap-0.5 p-0.5 rounded-md bg-neutral-50 border border-neutral-200` (echos's `size="md"`), triggers `rounded-sm text-muted-foreground hover:bg-neutral-200/50 data-[state=active]:text-primary`, indicator `rounded-sm border border-neutral-200 bg-white shadow-sm transition-all duration-300 ease-in-out`, and the measure-the-selected-rect approach |
| `src/ui/dropdown-menu.tsx` | `components/ui/dropdown-menu.tsx` | content `rounded-md border bg-popover p-1 shadow-md min-w-[8rem]`, items `rounded-sm px-2 py-1.5 text-sm gap-2 focus:bg-accent`, the destructive variant's `text-destructive focus:bg-destructive/10`, separator `-mx-1 my-1 h-px bg-border` |
| `src/ui/select.tsx` | `components/ui/select.tsx` | the SelectTrigger string: `rounded-md border-input`, `data-[size=default]:h-10` / `data-[size=sm]:h-8`, `focus-visible:ring-[3px] ring-ring/50`, and the `ChevronDownIcon` |
| `src/ui/skeleton.tsx` | `components/ui/skeleton.tsx` | `animate-pulse rounded-md bg-accent`, verbatim |
| `src/ui/states.tsx` (`EmptyState`) | `components/accounts/accounts-empty-state.tsx` | `flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border-[0.5px] border-[#E5E5E5] bg-[#FAFAFA] p-6`, the 84px visual slot, `text-xl font-semibold` title, centred `text-sm text-muted-foreground` body |
| `src/ui/states.tsx` (`ErrorState`) | `components/auth/error-boundary.tsx` + `components/ui/alert.tsx` | the destructive-titled panel with an icon, the message as `text-sm`, and a `Try again` outline button |
| `src/ui/toast.tsx` | `components/ui/sonner.tsx` | `w-[394px] rounded-xl border border-neutral-200 p-4`, the exact `shadow-[0px_10px_15px_-3px_rgba(0,0,0,0.1),0px_4px_6px_-2px_rgba(0,0,0,0.05)]`, primary-coloured check for success, `size-6` white close button |
| `src/app/shell.tsx` | `app/(main)/layout.tsx`, `components/ui/sidebar.tsx`, `components/navigation/app-sidebar.tsx`, `nav-manage.tsx` | `--sidebar-width: calc(var(--spacing) * 72)` (18rem) and `--header-height: calc(var(--spacing) * 12)` (3rem) as inline CSS properties; the `variant="inset"` content card (`m-2 ml-0 rounded-xl border border-sidebar-border bg-background h-[calc(100svh-1rem)] overflow-y-auto`); the nav button treatment from `sidebarMenuButtonVariants` — `rounded-sm p-2.5 font-medium text-sm`, `hover:bg-muted-foreground/10`, and the active state's `rounded-md border border-border bg-sidebar-accent text-foreground shadow-[0_1px_3px_0_rgba(0,0,0,0.1),0_1px_2px_-1px_rgba(0,0,0,0.1)]` with a `!text-primary` icon; group labels as `font-normal text-neutral-600 text-sm`; the footer's `bg-linear-to-b from-transparent to-sidebar` fade |
| `src/app/error-boundary.tsx` | `components/auth/error-boundary.tsx` | the class-component shape and the Card-with-destructive-title fallback, plus Try again / Reload |

### echos's hardcoded hexes, kept on purpose

`#FAFAFA` (table headers, empty-state and recessed panels), `#E5E5E5` (0.5px hairlines), `#404040`
(table header text), `#737373` (dialog close icon), `border-neutral-200` / `bg-neutral-50` (dialogs
and the tab rail). These are not tokens in echos either. They were kept as literals so the two apps
render identically rather than "close enough".

### Motion

Everything sits in echos's 120–300ms band with `ease`/`ease-out`/`ease-in-out`. The tab indicator is
`duration-300 ease-in-out`, exactly as echos has it. No bounce or elastic easing anywhere.

---

## 2. Where this diverges, and why

Each of these is a decision, not an oversight.

1. **Vite SPA instead of Next.js App Router.** echos is Next 16 with server components. This panel is
   a static bundle the Datum server hands out at `/admin/`, built to
   `packages/datum/public/admin` with `base: "/admin/"`. A Node-rendering framework inside the
   product server would mean a second runtime in the image for a single-operator admin page.

2. **Hash routing, ~55 lines, no router library.** `src/lib/router.ts`. One `index.html` covers
   every screen, so the server needs no SPA rewrite rules and deep links survive a cold start.

3. **Hand-rolled primitives instead of shadcn + Radix.** The dependency list is fixed: react,
   react-dom, lucide-react, clsx, tailwind-merge. No Radix, no `class-variance-authority`, no
   `tw-animate-css`. So:
   - `cva` variant maps became plain `Record<K, string>` lookups through `cn()` (`variant()` in
     `src/lib/cn.ts`). Identical output, no runtime, and the strings stay diff-able against echos.
   - `Dialog` reimplements what Radix gave echos for free — Escape to close, a focus trap that wraps
     both ways, focus restore to the trigger, body scroll lock, `role="dialog"` +
     `aria-modal` + `aria-labelledby`/`aria-describedby`. All verified in a browser.
   - `Select` is a native `<select>` wearing echos's `SelectTrigger` classes. On an admin panel,
     free keyboard and screen-reader behaviour beats a custom popover.
   - `DropdownMenu` and `HoverCard` use a click-outside listener and a `<body>` portal instead of
     Radix's.
   - The four `tw-animate-css` entrance animations echos leans on are written out as keyframes at
     the bottom of `src/index.css`, plus a `prefers-reduced-motion` block echos does not have.

4. **Outfit via a `<link>`, not `next/font/google`.** There is no `next/font` here. `index.html`
   loads Outfit from Google Fonts and `--font-sans` names `'Outfit'` directly instead of
   `var(--font-outfit)`. Both families fall back to the system stack, which is what an air-gapped
   self-hosted instance will render.

5. **`--font-mono` is a real monospace stack.** echos aliases `--font-mono` to Outfit and never
   renders code — the extraction report flagged "monospace never used" as one of its distinctive
   choices. Datum shows an id, hash, commit, scope path or sequence number on every screen, so it
   loads JetBrains Mono and falls back to `ui-monospace`. This is the largest single deviation and
   it is deliberate: rendering a commit sha in a geometric sans is a legibility bug.

6. **`tabular-nums` and uppercase micro-labels, which echos does not do.** `.datum-num` and
   `.datum-microlabel` in `src/index.css`. Counts and sequence numbers must not jitter while the
   rejection log polls every five seconds, and the detail panels need a field-name treatment that is
   quieter than echos's sentence-case `text-sm font-medium` labels when twelve of them sit in a
   grid.

7. **Three added tokens.** echos defines `--success` and `--warning` but, per its own extraction
   notes, "rarely uses" them; it has no blue semantic and no recessed one.
   - `--info` / `--info-foreground` — `--info` takes `--chart-4`'s exact value
     (`oklch(0.6187 0.2067 259.23)`). `derived` confidence needs its own colour.
   - `--dead` / `--dead-foreground` — the recessed surface for retired rows. Named rather than
     scattered as opacity utilities because it is used in five places and is load-bearing.
   Dark-mode counterparts were derived by matching the lightness relationships echos uses between
   its own light and dark values.

8. **Added badge variants.** echos ships four (`default`/`secondary`/`destructive`/`outline`); this
   adds `muted`, `success`, `info`, `warning`, `purple`, `danger`, `dead`. All follow echos's badge
   base string and use a tinted surface with a matching border rather than a solid fill, because a
   single assertions row can carry three badges and three solid fills would shout.

9. **`Button` variants dropped and one added.** Dropped `special`, `specialSecondary`,
   `editOutline`, `destructiveOutline` — echos-brand radial gradients that carry no meaning here.
   Added `primary` (a plain `bg-primary`), because echos's `default` variant is text-only and this
   app needs a filled primary action without importing a gradient.

10. **`grid-cols-1` on the dialog panel.** Tailwind's `grid-cols-1` is `minmax(0, 1fr)`, which stops
    a long monospace secret or a JSON block from blowing the panel past `max-w-lg`. Radix handles
    this for echos; without it the reveal-once dialog overflowed, which browser testing caught.

11. **No `next-themes`.** The full `.dark` token block is present and correct, but nothing toggles
    it yet; the panel renders light. Adding a toggle later is a class on `<html>` and no token work.

12. **Table column density.** echos's `Table` is built for horizontal scroll and this one keeps
    `overflow-x-auto`, but four tables were re-columned (pairs merged into stacked cells:
    confidence·kind, asserted-by·seq, reason·invariant, actor·route) so that at 1440px the row
    action is on screen rather than behind a scroll. Verified by measuring
    `scrollWidth === clientWidth` on assertions, keys and rejections.

---

## 3. Product decisions that drove visual choices

These are not echos patterns; they are Datum's thesis expressed in the design.

- **A superseded row is dead, not struck through.** `assertionRowClass` in
  `src/components/confidence.tsx`: muted `--dead` surface, 75% opacity, a heavy left border in the
  dead foreground and an explicit `superseded` badge with a link to the row that replaced it.
  Strikethrough was rejected because it reads as *edited*, and this store never edits anything.
- **Confidence has the only fully semantic colour scale in the app.** `measured` = success,
  `confirmed-by-human` = echos purple (the human-authority colour), `derived` = info blue,
  `unverified` = warning amber. Amber, never red: no agent may write `measured`, so `unverified` is
  the normal state of an honest write.
- **Neither side of a contradiction is the winner.** Both columns in
  `src/screens/contradictions.tsx` are identical containers at an identical type scale, separated by
  a `both live` divider. Presenting one as the answer would be the silent last-write-wins behaviour
  the store exists to refuse.
- **A gate has three states.** `GatePill` in `src/screens/missions.tsx`. `reached: null` renders as
  "no qualifying evidence" in a dashed warning pill that names the `requires_confidence` class it
  would accept, with `why_null` as help text. Rendering null as false would turn a missing
  measurement into a failing one.
- **Verification standing is stated, not implied.** `src/components/provenance.tsx` distinguishes
  "verification promoted this claim", "awaiting verification", "human testimony, not promoted",
  "derived — not a verification target", and — when `/admin/api/me` reports
  `verification.configured: false` — "verification not configured on this instance". The last one is
  an operator fact, not a pending queue, and saying "awaiting" there would be a lie.
- **The as-of control is sequence-based.** `asserted_at` is a sequence number, so a sequence is the
  only exact cut point; two writes in the same millisecond are still ordered. The field commits on
  blur or Enter rather than clamping per keystroke, which browser testing showed made it impossible
  to type a smaller number.
- **`asserted_at` is never formatted as a date.** `src/lib/format.ts` keeps `relativeTime` /
  `absoluteTime` for `created_at`, `at` and `checked_at` only.

---

## 4. Verified in a browser, not assumed

Driven against a throwaway fixture API kept in `/tmp` (never in this repo) in four modes —
populated, all-empty, 500-refusing, and no backend at all — plus the production bundle served by
`vite preview`:

- login's 401 / 429-with-retry-seconds / unreachable states as three visually distinct panels
- create key → reveal-once → copy → revoke, with `aria-invalid` and field errors on submit
- the assertions table's dead / contested / `inputs unresolvable` treatments, and the provenance
  popover on hover and on keyboard focus
- the as-of slider rewinding to sequence 4000 and correctly reporting the 96-minute value that was
  later superseded
- the lineage timeline labelling the `unverified → measured` step "promoted by verification"
- resolve dialog → three exits → toast; Escape closes; focus trapped both directions; focus
  restored to the trigger
- all three gate states on one mission
- every screen's empty state, every screen's error state, and a mid-session 401 redirecting to
  `#/login`
- a misconfigured proxy answering `/admin/api/me` with HTML, which is now caught by `readMe` in
  `src/app/session.tsx` and reported precisely instead of white-screening
- 430px-wide layout: sidebar swaps to a scrolling `MobileNav`, filters stack, contradiction cards
  become one column

---

## 5. What is not here

No telemetry, no analytics, no phone-home, no licence check, no feature flag, no paid tier, no
"upgrade" affordance. The only network calls the panel makes are to `/admin/api/*` on its own
origin, plus the Google Fonts stylesheet in `index.html`. `DATUM_ORG` is read from
`/admin/api/me`; the string "aeonmind" does not appear in `src/`.
