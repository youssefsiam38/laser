# laser UI design spec

This is the visual and interaction contract for `@lasercode/ui`. Every component
derives its colors, type, spacing, and motion from here. Deviations need a
decision in `STATUS_DETAILED.md`.

> **The palette and the fonts moved (D-33).** Colour, type, spacing, radius,
> shadow and motion are no longer values written in this file: they are
> **tokens the person can change in Settings**, compiled from a preset by
> `src/theme/`, and their contract is [`docs/ux-theme.md`](../../docs/ux-theme.md).
> The default preset is *Laser*, with Host Grotesk and Martian Mono as its
> default faces. The tables in "Tokens" and the family names in "Type" are kept
> as the **reference preset** — the proportions, roles and contrast floors
> every preset must still satisfy — and are no longer the shipped values. What
> is binding here and everywhere is the *shape*: which token carries which
> meaning, the legibility floor, the status language, the layout, and the
> motion budget below.

## Concept

A mission-control console for many agents across many projects. Dark-first,
calm, dense where it counts, quiet everywhere else. One accent means "live".
One warm hue means "needs you". Nothing else competes for attention. It must
read as a finished product, not a terminal costume and not a docs site.

## Tokens (the reference preset)

The names are binding; the hexes are the reference preset the contrast floors
were measured against. The shipped values come from `theme/presets.ts` and
land on `:root[data-theme]` (see `docs/ux-theme.md`).

Light:

| token | value | use |
| --- | --- | --- |
| `--bg` | `#F5F7FA` | page ground |
| `--surface` | `#FFFFFF` | panels, cards |
| `--surface-2` | `#EEF2F6` | rails, hover, code ground |
| `--line` | `#D6DEE7` | hairlines |
| `--ink` | `#131A22` | text |
| `--ink-2` | `#4A5866` | secondary text |
| `--ink-3` | `#5F6D7B` | tertiary, eyebrows |
| `--live` | `#1F6FEB` | running, links, primary action |
| `--attention` | `#8F5D14` | waiting for you |
| `--danger` | `#C53030` | errors |
| `--ok` | `#15803D` | success |

Dark:

| token | value |
| --- | --- |
| `--bg` | `#0B0F14` |
| `--surface` | `#121821` |
| `--surface-2` | `#1A222D` |
| `--line` | `#263140` |
| `--ink` | `#E6EDF3` |
| `--ink-2` | `#9FB0C0` |
| `--ink-3` | `#8393A3` |
| `--live` | `#4DA3FF` |
| `--attention` | `#F5B849` |
| `--danger` | `#FF6B6B` |
| `--ok` | `#4ADE80` |

Map these onto the shadcn/assistant-ui token names in `@theme inline`
(`--color-background: var(--bg)`, `--color-card: var(--surface)`,
`--color-muted: var(--surface-2)`, `--color-border: var(--line)`,
`--color-foreground: var(--ink)`, `--color-muted-foreground: var(--ink-2)`,
`--color-primary: var(--live)`, `--color-destructive: var(--danger)`, and the
`--color-sidebar*` family from surface/line/ink). Registry components then work
unmodified. Radius: `--radius: 8px`. Hairlines are 1px `--line`; no drop
shadows on flat panels; a single soft shadow only on floating things
(composer, popovers, sheets).

Theme switching: `data-theme="dark" | "light"` on `<html>`, written by
`theme/apply.ts`; the default follows `prefers-color-scheme` when "follow the
system" is on, persisted in localStorage, changed in Settings → Appearance.
There is no `.dark` class. Both themes get equal care.

`--ink-3` (both themes) and light `--attention` were darkened from their first
values (`#7B8895` / `#6B7A8A` / `#B7791F`) because they carry running text —
timestamps, hints, durations, the "waiting for you" subtitle — and measured
3.2–4.4:1 on `--surface-2`, under the 4.5:1 floor below. The values above are
≥ 4.7:1 on every ground in their theme, and white on light `--attention` is
5.6:1.

## Type

- UI and body: the theme's `--font-sans` (**Host Grotesk** by default), 14px
  base, 1.5 line height, transcript prose
  15px at max 80ch (`--measure-prose`).
- Typed things (paths, ids, commands, eyebrows, numbers): the theme's
  `--font-mono` (**Martian Mono** by default), 11–12px,
  `font-variant-numeric: tabular-nums`, eyebrows uppercase with `0.08em`
  tracking (`--tracking-eyebrow`).
- Display (empty states, project names in the rail tooltip): `--font-sans` 600.
- Faces are chosen in Settings → Appearance and loaded with `display=swap`
  behind real fallback stacks (`theme/fonts.ts`); a face is never named in a
  component.


## Legibility floor (binding everywhere, not just panels)

- **No data below 12px.** The 11px size is for uppercase eyebrows with
  `0.08em` tracking only — a category label, never a value. This holds at
  every viewport and inside every island, card and rail.
- **Shrink by dropping content, never by shrinking type.** A component that
  cannot fit its content at 12px shows less content, not smaller text.
- **Truncate, never condense.** A long value ends in an ellipsis at a fixed
  width with the full text in the tooltip and the accessible name. Never
  tighter tracking, never a condensed face, never a scale transform.
- **Nothing overflows its container.** The page body never scrolls sideways.
  Tables, code blocks, diffs and diagrams each get their own
  `overflow-x: auto` container.
- **Touch targets stay 44px** on coarse pointers even where the visible
  control is smaller; the hit area extends past the paint.

## Layout

Desktop (≥1024px), four columns left to right:

1. **Rail** (56px): project icons (initials in a ring), theme toggle, settings.
   The ring around a project icon shows aggregate status: solid `--live` arc
   while any session runs, `--attention` when any waits.
2. **Sessions** (288px): **every project**, as collapsible groups, each
   attention-sorted inside (waiting > error > finished-unread > working >
   idle, then by modified). One scrolling list, so quick navigation across
   projects never requires switching first (D-20). Each group header: project
   name, a `+` for a new session there, a collapse chevron. Each row: status
   dot, title (`--font-mono` id prefix when untitled), relative time, last tool
   or "waiting for you" subtitle. The rail's project icons jump to and filter
   that group rather than replacing the list. Collapsible to 0 with `[`.
3. **Thread** (flex): the assistant-ui thread. Max width 84ch (`--measure-thread`) centered, sticky
   top bar (session title, model, thinking, context ring, more menu), floating
   composer at the bottom with queue chips above it.
4. **Telemetry** (320px, collapsible with `]`): context ring with tokens,
   cost/turn usage, model and thinking, worker status, extension status pills,
   extension widgets (string lines rendered in `--font-mono`), history/tree
   panel (fork, jump, labels). Hidden by default under 1280px.

Tablet (768–1023px): rail + thread; sessions and telemetry become sheets.

Mobile (<768px): thread only. Top bar shows a back chevron that opens the
sessions sheet; project switcher inside it. Composer is `position: fixed`
with bottom inset `max(env(safe-area-inset-bottom), var(--kb))` where `--kb`
is driven by `visualViewport` resize+scroll (never `+`). Body never scrolls;
the thread viewport scrolls. Inputs are 16px on touch to avoid iOS zoom.

## Status language

One vocabulary everywhere (sidebar dot, rail ring, top bar, tab title):

| state | dot | motion |
| --- | --- | --- |
| working | `--live` | slow radar sweep (a conic gradient rotating 2s) |
| waiting_for_input | `--attention` | gentle pulse (opacity 1 → .6, 1.6s) |
| error | `--danger` | none |
| finished_unread | `--live` outline | none |
| idle | `--ink-3` | none |

`prefers-reduced-motion: reduce` disables sweep and pulse; state stays legible
by color and an `aria-label`.

## Transcript

- User messages: right-aligned, `--surface-2` block, 10px radius, no avatar.
- Assistant messages: left, no bubble, prose on the ground; a 2px `--live`
  left hairline appears only while streaming.
- Reasoning and tool calls: **one uninterrupted stretch collapses into one
  muted activity row** — "Reasoned · Read 5 files · Ran 2 commands" — with a
  chevron that restores the full reasoning and every individual tool row in
  chronological order (D-89). While live, the same row uses the thinking
  indicator to name either Thinking or the exact active tool. The per-session
  expanded-thinking preference opens any group containing reasoning; errors
  and decisions always open it. Each individual tool row: `[icon] verb
  path/or/summary ····· 120ms`. Verb in `--font-sans` 500, path in `--font-mono`. Rows expand to show args and result. `bash` expands into a terminal block (dark ground in
  both themes, `--font-mono`, stdout/stderr). `edit`/`write` show a diff. Errors
  get a `--danger` left hairline and the error text.
- Tool-associated dialogs (approval/select/input/editor raised while exactly
  one tool runs) render as a non-modal footer inside that tool row. "No" is
  never a dead end: it opens a feedback field that sends a follow-up.
- Free-standing dialogs render as cards above the composer (viewport footer).
- Extension notices: toast (sonner) for `notify`; `setStatus` as pills in the
  telemetry rail and top bar; widgets in the telemetry rail.
- Markdown via `@assistant-ui/react-markdown` with `remark-gfm`; never raw
  HTML (invariant 9). Code blocks: header with language + copy, highlighted by
  the assistant-ui Shiki element with the full bundled language catalog and
  Oniguruma TextMate engine, lazy and only after the fence closes.

## Composer

Directly above the composer, one **status line** on every width (D-20): the
turn's elapsed time and tokens, the fleet pill ("3 running · 1 needs you",
absent when nothing runs), and the session state in words ("waiting for
you", "working", "idle"). This is the ambient surface; it lives here rather
than in the top bar so the eye finds it in the same place on a phone and a
desktop, next to where you type.

Nothing sits below the composer: controls carry tooltips and the complete key
reference lives in Settings → Help and shortcuts. The reclaimed row belongs to
the transcript on every desktop session.

Floating card, `--radius-xl`, `--surface` on `--bg`, one soft shadow. Textarea
autosizes to 8 lines. Left: attach image (paste also works). Right: model
selector (popover with search), thinking level (the levels this model accepts,
of Pi's seven incl. `max`; hidden when the model does not reason), send/stop.

Three keys, and only three: **Enter** = prompt when idle, steer when running;
**Shift+Enter** = newline; **Cmd/Ctrl+Enter** = follow-up when running. On a
touch keyboard plain Enter is a newline and Send submits. Any other Enter
combination is swallowed on purpose (`composerSendPlan`), so no fourth binding
can arrive from a library default. Queue chips above the
composer: steer = solid `--live` outline, follow-up = dashed; "clear queue"
restores text into the composer.

## Motion

The budget, in full. Everything not on this list is instant, and every entry
takes its duration and easing from a `--motion-*` token — never a number in a
component — with a `prefers-reduced-motion` fallback that loses the movement
and nothing else. The OS switch reaches the tokens themselves
(`theme/store.ts`), so "reduced" is one value change, not a branch per
component.

1. **The status sweep** — a run that is working (`StatusDot`, `StatusRing`).
2. **The streaming caret** on the last text part.
3. **The morph** — a panel changing size or moving between the dock and the
   full window. One element, never destroyed and re-created: rectangle,
   radius and border move together (`--motion-morph`).
4. **Arrival** — an island appearing plays a short scale-in once, so a panel
   that opens itself is noticed rather than found later.
5. **Sheets and popovers** — slide and fade in `--motion-slow`.
6. **Collapsibles** — a measured height, played by `--motion-fast`.
7. **Digit rolls** — a number that changes rolls rather than jumps
   (`NumberTicker`), so a value that moves is legible while it moves.
8. **The first screen** — the empty state's greeting and its suggestions
   arrive on a short stagger. This is the one page-load motion there is, and
   it is the only one: nothing else animates because a page loaded.
9. **Shimmer** on a label that is waiting, and the attention pulse on a
   question that is blocking.

## Accessibility

Keyboard: `Cmd+K` command palette (later), `[`/`]` toggle rails, `Cmd+N` new
session, `Esc` closes sheets and dialogs. Every icon button has a tooltip and
an `aria-label`. Focus ring is 2px `--live`. Contrast ≥ 4.5:1 for text in both
themes.

## Do not

- Do not add gradients, glass, or colored card borders as decoration.
- Do not name a typeface, a colour, a size, a radius or a duration in a
  component. Every one of them is a token (`docs/ux-theme.md` T1).
- Do not center the transcript column's text.
- Do not use emoji as icons; use lucide.
- Do not render any transcript string as HTML.
