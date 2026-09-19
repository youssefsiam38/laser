# Telemetry column redesign — report

The column shipped as a stack of boxes: every section padded, then a bordered
card inside it, then tiles inside that. This pass keeps every behaviour and
every figure and removes one whole level of chrome, so the column reads as
numbers with names, not as a card gallery.

Scope: `packages/ui/src/components/telemetry/**`,
`packages/ui/src/components/shell/TelemetryPanel.tsx`,
`packages/ui/test/shell/**`, and three assistant-ui elements this surface
already claims in `docs/ux-elements.md` (Chart, Cost meter, Context display).
No token was added: everything needed already existed (`--surface-2` is the
ground, `eyebrow` / `typed` / `tnum` the type, `hairline-*` the rules).

## Chrome budget

Heights are read off the classes (`h-8`, `h-11`, `leading-xs`, `text-2xs`),
not off a screenshot; nothing here relies on a browser measurement.

| | Before | After |
| --- | --- | --- |
| Panel header | 48 px | 44 px |
| Scope bar | 32 px, truncated | 28 px (44 px if it wraps; nothing is hidden) |
| **Six section headers** | 6 × 44 = **264 px** | 6 × 32 = **192 px** |
| Chrome around one figure | section `px-4` + card `p-3` + 2 hairline borders | section `px-3` only |
| Content width for a figure at 320 px | 262 px | 296 px |
| Section icon | 24 px tinted circle | bare 14 px glyph, `--ink-3` |
| Cards in the column | 11 (`InstrumentCard`) | 0 — the helper is deleted |

Headers cost 192 px of the column, under the 200 px budget. On a coarse
pointer they grow to 44 px (`pointer-coarse:h-11`), as the legibility floor
requires; the 32 px budget is the fine-pointer desktop case.

The only bordered boxes left inside a telemetry section come from
`components/shell/AccountUsage.tsx` (its "allowance unavailable" and
"purchased credits" cards), which another owner holds — it is not in this
worker's write scope. They appear only when the session is account-billed
*and* the allowance has not loaded.

## The nine problems

1. **Card inside card.** `InstrumentCard` is gone from `section.tsx` and from
   all six sections; nothing in the column draws `border + rounded + padding`
   around a row any more. A section is now exactly: a hairline, a 32 px header
   row, `px-3` content. Where a group needs a ground it is flat `--surface-2`
   (the meter tracks, the file-row hover), never a bordered tile.
2. **Zeros repeated.** `hasApiCost` now means *there is a cost to show*: a
   settled `$0` is no API cost (`format.ts`). A session with no API cost is one
   line — `No API cost`, or `No API cost — account billed` when the turns went
   to a subscription. The meter, the per-model roll-up and the per-turn figure
   are not drawn at all, so `$0` cannot appear four times. With a real cost the
   meter returns in full, and the model id middle-truncates keeping its tail,
   with the cost on its line and the token split under it.
3. **A missing value printed as a number.** `autoCompactText` treats an absent
   *or zero* `thresholdTokens` as unreported: `Auto-compact on · threshold not
   reported`. Same voice as the composition's "not in this snapshot".
4. **Composition.** One bar plus one legend row (`<ul>`, wrapping, one item per
   category). A category at zero is named in the legend with its `0` and gets
   no tile and no bar segment. Four tiles ≈ 110 px became ≈ 46 px.
5. **The ring.** A 64 px ring rendering `0%` said nothing the number did not.
   The Context section now uses a second preset on the same element,
   `ContextDisplayMeter` (`ContextRingButton variant="meter"`): `Window` ·
   `22 / 8.0k` · `0%` on one line over a 4 px meter in the same tone
   vocabulary, still the button that opens the same window-health inspector.
   ~88 px became ~24 px. The composer and top bar keep the ring preset.
6. **The chart.** `Chart` gained `density="sparkline"`: a 32 px plot, hairline
   bars capped at 8 units, the label and the last value on one line, the last
   bar in `--live`. The window is stated once in the label — `Tokens per turn ·
   last 64 turns` when the series is windowed, `· 6 turns` when it is not, so
   the figure never claims a longer window than it has. Advanced resource
   diagnostics keeps the full 72 px plot.
7. **Work.** A definition list: `Turns`, `Wall clock`, `Tool calls`, then the
   ranked tools where the bar is a quiet 40 px inline meter in `--ink-3` (the
   accent is for live, not for a histogram), then `Failed` with the tool names
   in `--danger`. Three cards became eight rows in less height.
8. **Section headers.** Chevron · optional 14 px icon · eyebrow · the section's
   number, in 32 px, with no circle behind the icon. The number is still
   rendered while the section is collapsed (existing test kept).
9. **The scope bar.** It wraps instead of truncating, so
   `Whole session · 21 records · 0 compactions` says the compactions count
   rather than hiding it behind an ellipsis; the full text stays in `title`.

Also, in Files: the file **name** is never what gives way. `pathDisplay`
keeps the basename whole and middle-truncates the directory around it
(`pack…lemetry/files-section.tsx`), with the full path in the row hint and the
accessible name; the directory is `--ink-3` and the name `--ink`. The
repository row keeps its branch (`data-slot="telemetry-repo-branch"`), and the
totals line is a row, not a card.

## `docs/ux-elements.md` rows touched

| Row | What changed |
| --- | --- |
| **Chart** | Records the `density="sparkline"` form used by the column and that the full plot stays for Advanced resource diagnostics |
| **Cost meter** | Records that a settled `$0` counts as no API cost, and the middle-truncated model id with the token split on its own line |
| **Context breakdown** | Records that composition is one bar plus one legend row, a zero category named and never tiled |
| **Context display** | Records the second preset (`ContextDisplayMeter`) and why the column does not use the ring |

## Tokens and legibility

No hex, no `oklch()`, no raw `px` font size and no arbitrary spacing was
added. 11 px appears only through the `eyebrow` utility (section titles,
"Failed"); every value is `typed` (12 px mono, tabular) or `text-xs`. Both
themes come from the same tokens, so neither is drawn twice. At 320 px every
row either wraps or middle-truncates with the full value in `title` — nothing
sets a fixed width that can overflow.

## What to look at first

1. **Spend on a stub session.** It must be one line. That is the change with
   the clearest before/after against `/tmp/leap-ui/14-tel.png`.
2. **Context.** The meter row, then `Auto-compact on · threshold not reported`,
   then the bar and the four-item legend — where `Thinking 0` is a legend
   entry, not a tile.
3. **The whole column's silhouette** in both themes: the only lines should be
   the six section hairlines. Any rounded rectangle left in the column is
   either a meter track or `AccountUsage`, which another owner holds.
4. **The sparkline** with a few turns, and with more than 64.
5. **A long file path and a long branch** in Files, at 320 px.
