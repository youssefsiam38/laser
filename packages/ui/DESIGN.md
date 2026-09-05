# piorbit UI design spec — "Ground Station"

This is the visual and interaction contract for `@piorbit/ui`. Every component
derives its colors, type, spacing, and motion from here. Deviations need a
decision in `STATUS_DETAILED.md`.

## Concept

A mission-control console for many agents across many projects. Dark-first,
calm, dense where it counts, quiet everywhere else. One accent means "live".
One warm hue means "needs you". Nothing else competes for attention. It must
read as a finished product, not a terminal costume and not a docs site.

## Tokens (CSS variables on `:root`, dark on `.dark`)

Light (`:root`):

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

Dark (`.dark`):

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

Theme switching: `.dark` class on `<html>`, default from `prefers-color-scheme`,
persisted in localStorage, toggle in the rail. Both themes get equal care.

`--ink-3` (both themes) and light `--attention` were darkened from their first
values (`#7B8895` / `#6B7A8A` / `#B7791F`) because they carry running text —
timestamps, hints, durations, the "waiting for you" subtitle — and measured
3.2–4.4:1 on `--surface-2`, under the 4.5:1 floor below. The values above are
≥ 4.7:1 on every ground in their theme, and white on light `--attention` is
5.6:1.

## Type

- UI and body: **Host Grotesk** (Google Fonts), 14px base, 1.5 line height,
  transcript prose 15px at max 72ch.
- Typed things (paths, ids, commands, eyebrows, numbers): **Martian Mono**,
  11–12px, `font-variant-numeric: tabular-nums`, eyebrows uppercase with
  `0.08em` tracking.
- Display (empty states, project names in the rail tooltip): Host Grotesk 600.
- Load both from `fonts.googleapis.com` with `display=swap` and real fallback
  stacks.


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
2. **Sessions** (288px): attention-sorted list for the selected project
   (waiting > error > finished-unread > working > idle, then by modified). Each
   row: status dot (see Status), title (Martian Mono id prefix when untitled),
   relative time, last tool or "waiting for you" subtitle. "New session" at top.
   Collapsible to 0 with `[` .
3. **Thread** (flex): the assistant-ui thread. Max width 76ch centered, sticky
   top bar (session title, model, thinking, context ring, more menu), floating
   composer at the bottom with queue chips above it.
4. **Telemetry** (320px, collapsible with `]`): context ring with tokens,
   cost/turn usage, model and thinking, worker status, extension status pills,
   extension widgets (string lines rendered in Martian Mono), history/tree
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
- Reasoning: collapsible row "Reasoning · 3.2s" with a shimmering label while
  streaming; collapsed by default once complete.
- Tool calls: one-line rows in a tight stack. `[icon] verb  path/or/summary
  ····· 120ms`. Verb in Host Grotesk 500, path in Martian Mono. Rows expand to
  show args and result. `bash` expands into a terminal block (dark ground in
  both themes, Martian Mono, stdout/stderr). `edit`/`write` show a diff. Errors
  get a `--danger` left hairline and the error text.
- Tool-associated dialogs (approval/select/input/editor raised while exactly
  one tool runs) render as a non-modal footer inside that tool row. "No" is
  never a dead end: it opens a feedback field that sends a follow-up.
- Free-standing dialogs render as cards above the composer (viewport footer).
- Extension notices: toast (sonner) for `notify`; `setStatus` as pills in the
  telemetry rail and top bar; widgets in the telemetry rail.
- Markdown via `@assistant-ui/react-markdown` with `remark-gfm`; never raw
  HTML (invariant 9). Code blocks: header with language + copy, highlighted by
  `@assistant-ui/react-syntax-highlighter` (hljs light, async) only after the
  fence closes.

## Composer

Floating card, 12px radius, `--surface` on `--bg`, one soft shadow. Textarea
autosizes to 8 lines. Left: attach image (paste also works). Right: model
selector (popover with search), thinking level slider (7 levels incl. `max`),
send/stop. Enter = prompt when idle, steer when running; Shift+Enter =
newline; Cmd/Ctrl+Enter = follow-up when running. Queue chips above the
composer: steer = solid `--live` outline, follow-up = dashed; "clear queue"
restores text into the composer.

## Motion

Only three moments: the status sweep, the streaming caret on the last text
part, and panel slide for sheets (200ms, ease-out). Everything else is
instant. No page-load choreography.

## Accessibility

Keyboard: `Cmd+K` command palette (later), `[`/`]` toggle rails, `Cmd+N` new
session, `Esc` closes sheets and dialogs. Every icon button has a tooltip and
an `aria-label`. Focus ring is 2px `--live`. Contrast ≥ 4.5:1 for text in both
themes.

## Do not

- Do not add gradients, glass, or colored card borders as decoration.
- Do not use Inter, Geist, or Space Grotesk.
- Do not center the transcript column's text.
- Do not use emoji as icons; use lucide.
- Do not render any transcript string as HTML.
