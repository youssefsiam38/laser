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

- UI, body and transcript prose: the theme's `--font-sans` (**Host Grotesk**
  by default), 14px base, 1.5 line height. Transcript prose keeps the max 80ch
  reading measure (`--measure-prose`) and uses the compact 20px message rhythm.
- Typed things (paths, ids, commands, eyebrows, numbers): the theme's
  `--font-mono` (**Martian Mono** by default), 11–12px,
  `font-variant-numeric: tabular-nums`, eyebrows uppercase with `0.08em`
  tracking (`--tracking-eyebrow`).
- Display (empty states, project names in the rail tooltip): `--font-sans` 600.
- Faces are chosen in Settings → Appearance and loaded with `display=swap`
  behind real fallback stacks (`theme/fonts.ts`); a face is never named in a
  component.


## Legibility floor (binding everywhere)

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
   Rings are neutral directory markers; selection indicates the project
   filter, never aggregate session attention (D-103).
2. **Sessions** (288px): **every project**, as collapsible groups, each
   newest first inside. One scrolling list, so quick navigation across
   projects never requires switching first (D-20). Each group header: project
   folder/name, a `+` for a new session there, a collapse chevron. Each row is
   one compact line with a rounded neutral selection, title and trailing
   activity: a working spinner, or a waiting/error/unread marker; idle is quiet.
   Timestamps and previews live in the row tooltip. Pinned chats move into a
   top section (never duplicated) with a muted 12px project label and full
   path tooltip. Touch rows retain 44px targets. The rail's project icons jump to and filter
   that group rather than replacing the list. Collapsible to 0 with `[`.
3. **Thread** (flex): the assistant-ui thread. Max width 84ch (`--measure-thread`) centered, sticky
   top bar (session title, model, thinking, context ring, more menu), floating
   composer at the bottom with queue chips above it.
4. **Fleet** (320px, collapsible with `\`): the open session's tree of agent
   work — its child agents, theirs, and the background commands any of them
   left running — nested as it really nests, opening in place, with work from
   a deleted session carried on one line at the bottom
   ([`docs/ux-fleet.md`](../../docs/ux-fleet.md)). Hidden by default under 1280px.
5. **Monitor** (320px, collapsible with `]`): context ring with tokens;
   billing-aware usage (API cost/tokens or account allowance/resets/credits,
   with Account/API tabs only when both occur). A child agent contributes its
   model, never invented numbers; model and thinking, worker status,
   extension status pills, history/tree panel (fork, jump, labels). Hidden by
   default under 1280px. Its top-bar and command-palette entry uses the same
   activity mark as the Telemetry header; panel-edge glyphs are reserved for
   collapsing an already open sidebar.

The fleet sits immediately left of the monitor: from the right edge inward,
monitor then fleet. Each collapses on its own.

Tablet (768–1023px): rail + thread; sessions, fleet and monitor become sheets.

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
by color and an `aria-label`. Session-sidebar rows reserve their width for names:
root sessions use this activity mark, child sessions use the equivalent run-state
dot, and a parent's fold disclosure inherits the highest-attention descendant
state. Visible status words and descendant-state chips belong in the fleet, not
beside session titles; sidebar disclosure names and tooltips retain the full text.

## Transcript

- User messages: right-aligned, `--surface-2` block, 10px radius, no avatar.
- Assistant messages: left, no bubble, prose on the ground; a 2px `--live`
  left hairline appears only while streaming.
- Reasoning and tool calls: **one uninterrupted stretch collapses into one
  muted activity row** — "Reasoned · Read 5 files · Ran 2 commands" — with a
  chevron that restores the full reasoning and every individual tool row in
  chronological order (D-89). While live, the same row uses the thinking
  indicator to name either Thinking or the exact active tool. The per-session
  Activity detail choice has three levels: Answers only keeps the aggregate
  closed, Show reasoning keeps the aggregate closed but expands reasoning inside
  when the reader opens it, and Show everything opens both levels. Errors and
  decisions start their aggregate open; a manual toggle takes precedence.
  Each child, including reasoning, uses the same `[icon] label · detail · duration ›`
  row on `--surface` in `--ink-2`; chevrons align at the end. A single action has
  no redundant aggregate parent. Each row expands independently; waiting tools
  can fold their details without hiding their approval footer. Verb in
  `--font-sans` 500, path in `--font-mono`. Rows expand to show args and result. `bash` expands into a terminal block (dark ground in
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
autosizes to 8 lines. Left: attach image (paste also works). Right: before an
ordinary project's first prompt, a searchable agent selector immediately left
of the model selector; then model, thinking and send/stop. The agent starts on
the configured default, excludes built-in and empty Chat channels, moves draft
text when switched, refuses to strand attachments, and disappears after the
first prompt. Thinking shows only levels the effective model accepts (of Pi's
seven, including `max`); a pre-turn change creates or reuses the empty session
and is session-only. Input and Send lock until either preparation finishes, so
the first prompt cannot race the chosen identity or level. Persistent
model/thinking defaults remain in Settings.

Three keys, and only three: **Enter** = prompt when idle, join the queue when
running; **Shift+Enter** = newline; **Cmd/Ctrl+Enter** = steer when running. On
a touch keyboard plain Enter is a newline and Send submits. Any other Enter
combination is swallowed on purpose (`composerSendPlan`), so no fourth binding
can arrive from a library default.

Writing while the agent works never interrupts it. The message becomes a row
directly above the composer that says what happens if it is left alone —
"After this turn" — and carries the three acts that change that: **Steer**
(one click, goes in at the next step), the delete icon (drops just this one)
and **⋯** (edit it back into the composer, copy it, drop them all). A row
already handed to the engine reads "Up next" with a solid `--live` rule and no
controls, because there is no verb behind them; a waiting row is dashed. A
delivery that failed keeps its message and shows the reason. Steering never
stops anything, so the transcript records only the message and the reply —
"You stopped it" belongs to the Stop button and to nothing else.

## Motion

The budget, in full. Everything not on this list is instant, and every entry
takes its duration and easing from a `--motion-*` token — never a number in a
component — with a `prefers-reduced-motion` fallback that loses the movement
and nothing else. The OS switch reaches the tokens themselves
(`theme/store.ts`), so "reduced" is one value change, not a branch per
component.

1. **The status sweep** — a run that is working (`StatusDot`, `StatusRing`).
2. **The streaming caret** on the last text part.
3. **The morph** — a surface changing size or moving between hosts (a fleet
   row opening its detail, the map going full-screen). One element, never
   destroyed and re-created: rectangle, radius and border move together
   (`--motion-morph`).
4. **Arrival** — something that opens itself plays a short scale-in once, so
   it is noticed rather than found later.
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
session, `Ctrl/Cmd+F` finds in the current conversation, `Ctrl/Cmd+Shift+F`
searches all saved sessions, and `Esc` closes search, sheets and dialogs.
Find uses Enter/Shift+Enter to navigate matches. Global results use arrows and
Enter; their highlighted excerpts stay in the row's normal flow. Every icon button has a tooltip and
an `aria-label`. Focus ring is 2px `--live`. Contrast ≥ 4.5:1 for text in both
themes.

## Do not

- Do not add gradients, glass, or colored card borders as decoration.
- Do not name a typeface, a colour, a size, a radius or a duration in a
  component. Every one of them is a token (`docs/ux-theme.md` T1).
- Do not center the transcript column's text.
- Do not use emoji as icons; use lucide.
- Do not render any transcript string as HTML.
