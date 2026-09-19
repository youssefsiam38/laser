# Reduced motion: closing surfaces that never left the document

Branch `agents/reduced-motion-dialog-ghosts-7bb5920b`, from `main` at
`101b5f41` (which already carries the one-dialog fix for the undo
confirmation).

## 1 · The defect, measured

Radix `Presence` decides whether to wait for an exit animation from the
computed `animation-name` alone. If it is anything but `none`, the element
stays mounted (`unmountSuspended`) until `animationend` or `animationcancel`
arrives on it (`@radix-ui/react-presence/dist/index.mjs`, `usePresence`).

Our closed state is `data-[state=closed]:animate-out`, which compiles to
`animation: exit var(--tw-duration…) … var(--tw-animation-fill-mode, none)`,
and `--tw-duration` is `var(--motion-instant)` — `0ms` when Motion is reduced
(`packages/ui/src/theme/compile.ts`, `packages/ui/src/globals.css`).

Measured in Chromium on a bare page, one `@keyframes exit`, listeners attached
before the state change (`/tmp/probe4.html` during this task):

| declaration | `getAnimations()` | events | computed `animation-name` |
| --- | --- | --- | --- |
| `exit 0s ease 0s 1 normal none` | `[]` | **none, ever** | `exit` |
| `exit 0s ease 0s 1 normal both` | `exit:finished` | start + end | `exit` |
| `exit 0.01ms …` | `exit:running` | start + end | `exit` |
| `exit 150ms …` | `exit:running` | start + end | `exit` |

The fill mode is what decides it: **a zero-duration animation with no fill is
never created at all**, so no event is ever delivered — and every tw-animate
utility uses `fill-mode: none`. `Presence` parks in `unmountSuspended` and the
closed dialog stays in the document, painted, with live buttons.

One nuance found while sweeping, which matters for where the fix belongs:
tw-animate-css ships a global accessibility block that survives into our
bundle —

```css
@media (prefers-reduced-motion: reduce) { *, ::before, ::after {
  animation-duration: .01ms !important; … } }
```

— so the **OS** preference alone happened to be rescued by that `!important`
0.01 ms (row three above: it does fire). The path that actually ghosts is
**Settings → Appearance → Motion: Reduced** with no OS preference, because the
compiled theme writes `--motion-instant: 0ms` on `:root[data-theme]` and no
media query applies. Relying on an upstream accessibility rule for correctness
is not a fix; both paths are now handled, and neither depends on it.

## 2 · The root chosen, and why

**Load-bearing: the token.** Under reduced motion the enter/exit utilities
carry no animation at all, so `Presence` sees `animation-name: none` and
unmounts immediately — the branch Radix already has (`currentAnimationName ===
"none"` → `send("UNMOUNT")`).

- `packages/ui/src/theme/compile.ts` writes one new token beside the
  durations: `--motion-off: none` when `theme.motion === "reduced"`, and the
  guaranteed-invalid `initial` otherwise.
- `packages/ui/src/globals.css` re-declares tw-animate-css's own theme values
  with that one wrapper: `--animate-in`, `--animate-out`,
  `--animate-collapsible-down/up`, `--animate-accordion-down/up` become
  `var(--motion-off, <the original shorthand>)`. `--motion-off: initial` makes
  `var()` take the fallback, so with motion on the animation is exactly what
  it was.
- The `@media (prefers-reduced-motion: reduce)` block sets `--motion-off:
  none` too, for the frame before the theme store runs. The store already
  folds the OS preference into the compiled theme (`theme/store.ts`), so the
  `:root[data-theme]` write stays consistent with it.

Verified in Chromium (`/tmp/probe.html`): `--motion-off: none` →
`animation-name: none`, `getAnimations()` empty, nothing to wait for;
`--motion-off: initial` → `exit`, one running animation, its end delivered.

Why the token and not only the component: it is one rule for every surface
built on Radix `Presence`, including the ones we do not wrap (assistant-ui's
thread-list menu, the conversation map's HoverCard) and the collapsible
height animations, where a stranded "closed" body stays *open*. It is also the
honest reading of the preference — AGENTS.md: a reduced-motion fallback loses
the movement and nothing else.

**Also done, as the floor: the shared components.**
`packages/ui/src/components/ui/exit-presence.ts` adds `useExitPresence(ref)`, a
composed ref that watches `data-state` and, when an element is closed, still in
the document, and the browser reports **no live animation** on it, dispatches
the `animationend` `Presence` is waiting for. It never shortens a real exit:
while `getAnimations()` reports a running (or paused) animation it re-arms and
does nothing, so the fade plays to its end and Radix's own listener ends it.
Measured that a real exit is reported as running both at the mutation and at
the next task, and is gone from `getAnimations()` once it ends
(`/tmp/probe2.html`).

It covers what a token cannot: a dropped event, an animation removed while the
page was hidden, a future stylesheet that promises an animation the engine
never starts. It is what makes the guarantee testable at the component level,
and it is why `components/thread/dialog-presence.ts` could be deleted instead
of copied.

**Deleted:** `packages/ui/src/components/thread/dialog-presence.ts` and its
test. Its four callers now use the shared dialog with a plain `open` flag:
`UndoTurn.tsx`, `GoalBar.tsx` (two dialogs), `ProjectLine.tsx`,
`BodyOverflow.tsx`. They keep their behaviour and their tests, which now pass
*through* the shared component's guarantee rather than a local copy of it.

## 3 · The sweep

Everything under `packages/ui/src/**` that uses `animate-out`,
`data-[state=closed]` or any other exit that gates a removal.

### Shared components (`packages/ui/src/components/ui/**`) — token + guard

| Surface | Exit idiom | Verdict |
| --- | --- | --- |
| `dialog.tsx` `DialogContent` | `data-[state=closed]:animate-out` | Fixed: token + `useExitPresence`. Was the reported ghost. |
| `dialog.tsx` `DialogOverlay` | same | Fixed: token + guard. The wash behind the dialog. |
| `sheet.tsx` `SheetContent` | `data-[state=closed]:animate-out` + slide-out | Fixed: token + guard. |
| `sheet.tsx` `SheetOverlay` | same | Fixed: token + guard. |
| `popover.tsx` `PopoverContent` | `data-[state=closed]:animate-out` | Fixed: token + guard. |
| `dropdown-menu.tsx` `DropdownMenuContent` | same | Fixed: token + guard. |
| `dropdown-menu.tsx` `DropdownMenuSubContent` | same | Fixed: token + guard. |
| `tooltip.tsx` `TooltipContent` | same | Fixed: token + guard. A stuck tooltip is visible, so it counts. |
| `collapsible.tsx` `CollapsibleContent` | callers add `animate-collapsible-up` | Fixed: token + guard. A stranded collapse leaves the body *open*. |
| `command.tsx` | none of its own; the palette is a `DialogContent` | Inherits the dialog's fix. |
| `scroll-area.tsx`, `tabs.tsx`, `toggle.tsx`, `separator.tsx`, `hint.tsx`, … | no exit animation | Safe: nothing gates their removal. |

### Every surface built on those (read, not edited)

All of these mount through the shared components above and inherit both the
token and the guard: the changes overlay and its file-tree sheet and
`git-dialog.tsx` (`source-control/**`, another worker's area — read only), the
fleet sheet (`components/fleet/FleetSheet.tsx`, likewise), the command palette,
global search, the API request inspector and the logs screen, settings
(device cache, log store, MCP add/import/inspector/sign-in, scope draft
guard), first-run, trust, add/move project, the model and context dialogs,
the attachment browser, the file viewer, the large-body viewer, the agents
end/remove-worktree dialogs, the agent map inspector sheet, the Beam model
dialog and Beam's phone sheet, the PWA install prompt, and the 9 popovers,
9 dropdown menus, 17 tooltips and 21 collapsibles in the app.

### Surfaces outside `components/ui/**` — token only (not our wrappers)

| Surface | Exit idiom | Verdict |
| --- | --- | --- |
| `assistant-ui/elements/thread-list.aui.tsx` `menuContentClass` | `data-[state=closed]:animate-out` on assistant-ui's own menu content | Was broken under both the knob and the OS path; fixed by the token. No JS guard: we do not own the element. |
| `assistant-ui/elements/conversation-map.tsx` HoverCard | `data-[state=closed]:animate-out` + `motion-reduce:animate-none` | Was safe under the OS preference only (the `motion-reduce:` variant is a media query); the Settings knob path is fixed by the token. |
| `assistant-ui/elements/surfaces.tsx` `collapsePanel` | `animate-collapsible-*` + `motion-reduce:animate-none` | Same: OS-safe before, both paths safe now. |
| `assistant-ui/elements/reasoning.tsx` | `animate-collapsible-*` + `motion-reduce:animate-none` | Same. |

### Already safe for their own reasons (checked, unchanged)

| Surface | Why it was already safe |
| --- | --- |
| `components/beam/BeamBubble.tsx` (desktop bubble) | Its own phase machine: `onAnimationEnd` **plus** a `setTimeout(motionMs("--motion-morph") + 40)` fallback, and `motion-reduce:animate-none`. The timer covers the knob path too. |
| `assistant-ui/elements/loading-state.tsx` (startup screen exit) | Not Presence; it unmounts itself on `onAnimationEnd`. Its animation is `startup-depart var(--motion-morph) … both` — the **`both` fill mode** means the zero-duration animation *is* created and does end (row two of the table), and the element is at `opacity: 0` in the meantime. Left alone; flagged below as the one place that would strand if that fill mode were ever dropped. |
| `sonner` toasts | Removal is a timer (`TIME_BEFORE_UNMOUNT = 200`), never an animation event. |
| `.caret`, `.shimmer-text`, `.conversation-breathe`, `.activity-beam`, `--animate-sweep/busy/attention/caret/shimmer` | Looping indicators. They gate no removal, and they are deliberately **not** switched off: a spinner that stops spinning reads as frozen, not as calm. |
| Workbench/settings panels, `SettingsScopeControls` | No exit animation; they are routed panels, not presence. |

## 4 · Tests, and the mutations that break them

New: `packages/ui/test/theme/reduced-motion.test.ts` (5 tests) — compiles the
real `globals.css` with the real Tailwind (`compile()` from `tailwindcss`,
`tw-animate-css` resolved through its `style` export) over every `animate-*`
class the app actually spells, and asserts that **every** rule it emits whose
selector carries `[data-state…]` and sets `animation:` goes through
`var(--motion-off, …)`; plus the compiler's token values, the
`prefers-reduced-motion` block, and that the fallback still carries the full
`exit` shorthand.

New: `packages/ui/test/ui/exit-presence.test.tsx` (8 tests) — mounts real
Radix surfaces in a browser that reports the defect (computed `animation-name`
follows `data-state`, no animation object, no event ever): the dialog leaves on
Cancel and on Escape and re-opens cleanly, **nothing** is left in the document
(no `[data-state]` node at all), and the sheet with its overlay and the popover
inherit the same guarantee. Two tests hold the other side: with an animation the
browser reports as *running*, the dialog stays through its fade and leaves on
its own `animationend`; and when the animation is over but the event never
arrives, the guard still ends it. Plus `exitWindowMs` units.

Kept and re-pointed: `packages/ui/test/thread/undo-turn-presence.test.tsx`
(5 tests) now proves the originally reported surface through the shared
component, with no thread-local hook.

Removed: `packages/ui/test/thread/dialog-presence.test.tsx` (its subject is
deleted) and the `dialogExitMs` unit block in `undo-turn.test.ts`.

Mutation evidence — each mutation applied to the fixed tree, tests run, then
reverted:

| # | Mutation | Result |
| --- | --- | --- |
| M1 | `--animate-out` in `globals.css` left unwrapped (tw-animate's own value) | `reduced-motion.test.ts`: **2 failed**, 3 passed — "gates every animation the app drives from a `data-state`", "gates the enter/exit utilities themselves" |
| M2 | `--motion-off` never written by `theme/compile.ts` | **11 failed** across `reduced-motion.test.ts` + `theme.test.ts` (9 presets, the `:root` block, the token itself) |
| M3 | `useExitPresence` removed from `dialog.tsx` (content and overlay) | `exit-presence.test.tsx` **4 failed**; with `undo-turn-presence.test.tsx` in the same run, **7 failed** |
| M4 | guard ignores a live animation (`if (live === true)` → never) | **2 failed**: "keeps the dialog through its fade and lets the animation end it", "ends it anyway when the animation is over and the event never arrives" |
| M5 | `useExitPresence` removed from `sheet.tsx` and `popover.tsx` | **2 failed**: the sheet and the popover inheritance tests |

## 5 · Validation

Run in this worktree, on the branch tip:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | clean |
| `pnpm -F @lasercode/ui test` | 313 files, **2889 passed**, 1 skipped (one run tripped the pre-existing 5 s timeout in `test/runtime/view-cache.test.ts` "plateaus with the capped live tail…", a load-sensitive perf test that passes on its own — 40/40 — and passed in the other full runs; unrelated to this change) |
| `pnpm -F @lasercode/ui typecheck` | clean |
| `pnpm -F @lasercode/ui build` | built; `dist/assets/index-*.css` carries `animation:var(--motion-off,enter…/exit…/collapsible-…)`, `:root{--motion-off:initial}` and `@media(prefers-reduced-motion:reduce){:root{…--motion-off:none}}`, and no unwrapped `animation:exit`/`animation:enter` anywhere in any chunk |
| `pnpm identity:check` | "every generated file agrees, no stray literals" |
| `pnpm direction:check` | "no physical layout utilities or CSS properties" |

No Playwright acceptance and no `scripts/browser-check` were run, as asked. The
Chromium use in this task was three bare-page CSS probes (the tables above),
not the app.

## 6 · What still cannot unmount

- **Nothing found that ghosts.** Every exit that gates a removal is either
  behind `--motion-off`, behind `useExitPresence`, or on its own timer.
- **One dependency worth knowing about**: the startup screen
  (`loading-state.tsx`) unmounts itself on `onAnimationEnd` with no timer. It
  is safe only because its animation declares `fill-mode: both`, which makes
  even a zero-duration animation exist and end. If that fill mode is ever
  dropped, or the element's animation becomes `none`, the splash would stay in
  the document (invisible at `opacity: 0`, `pointer-events: none`, so a leak
  rather than a blocker). It is outside this task's area; the safe change
  would be BeamBubble's pattern — an `onAnimationEnd` with a
  `motionMs("--motion-morph") + slack` fallback.
- **tw-animate-css bumps**: `globals.css` re-declares four of its theme values
  (six with accordion). If the package changes those shorthands, the wrapper
  must be re-synced; `test/theme/reduced-motion.test.ts` fails loudly if a
  state-driven utility escapes the switch, but it cannot notice a *changed*
  duration default inside the fallback.
- **Assistant-ui's own elements** (`thread-list.aui.tsx` menu, the
  conversation map HoverCard) rely on the token alone — no JS floor — because
  they are not our wrappers. If one of them ever animates outside the
  `animate-*` utilities, it would need its own handling.
