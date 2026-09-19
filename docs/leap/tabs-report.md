# Tabs and segmented controls

What the `Chat | Code` control and its relatives looked like before this change:
a full-width grey track (`bg-surface-2 p-0.5`) with a white filled pill
(`bg-surface … shadow-float-sm`) sliding between two 12px words. Five other
surfaces drew the same widget by hand, with four different keyboards behind it
and three different ideas of what "selected" looks like.

## 1 · The idiom

**Quiet ground, one rule.** A selected option keeps the panel's own ground —
there is no track behind the row and no filled pill on top of it — and is named
by exactly two things: full-strength `--ink` on its label, and a 2px `--ink`
rule (`h-0.5 bg-ink`) riding the strip's hairline underneath it.

| state | paint |
| --- | --- |
| selected | `--ink` label, `--ink-2` count, 2px `--ink` rule on the hairline |
| unselected | `--ink-2` label, `--ink-3` count, no ground, no rule |
| hover (unselected) | ground changes to `--surface-2`, label to `--ink` |
| pressed | same ground, `--ink` label (`active:`) |
| focus | the app's focus ring: 2px `--live`, painted **inside** the option (`-outline-offset-2`) so a neighbour never clips it |
| disabled (one option) | `opacity-45`, not in the arrow order, not a landing place |
| disabled (whole group) | `opacity-60`, `aria-disabled`, no tab stop, keys inert |

**Why a rule and not a pill.** DESIGN.md is explicit: "Hairlines are 1px
`--line`; no drop shadows on flat panels; a single soft shadow only on floating
things". The old control put `shadow-float-sm` on a flat sidebar — the spec
forbids it outright — and the track was a box where this product uses lines.
A rule on the strip's hairline is the same vocabulary as every other divider in
the app, it costs no ground, and it is one element that grows into place
(`scale-x` + opacity on `--motion-fast`, nothing under reduced motion) rather
than a pill that pops between two boxes.

**Why the rule is ink and not `--live`.** The accent is spoken for: "One accent
means *live*. One warm hue means *needs you*. Nothing else competes for
attention" (DESIGN.md "Status language"). These very tabs carry a status dot
for a conversation in the *hidden* tab, and `finished_unread` is drawn as a
`--live` outline. A steady blue underline beside a blue activity dot would say
"something is running here" when it only means "you are here". Ink says where
you are; colour stays evidence about the agents. `--live` keeps the one job it
already had on this control: the focus ring.

**At a narrow width.** The options are content-sized and sit at the start of
the row, so two tabs take about half of the 288px sidebar instead of stretching
a grey bar across it; labels truncate with `min-w-0 truncate` before they wrap,
counts never shrink (`shrink-0`), and nothing below 12px is drawn — the label is
13px (`text-sm`), the count 12px mono (`typed`). A strip with more options than
fit takes `overflow-x-auto` from its call site (the MCP inspector does) rather
than shrinking its type. Touch keeps 44px (`pointer-coarse:min-h-11`) even
where the paint is 32px.

## 2 · The shared control

`packages/ui/src/components/ui/tabs.tsx` — one implementation, two roles:

- `Tabs` — navigation: `role="tablist"` / `role="tab"` / `aria-selected`, and
  the strip draws the hairline the rule rides (`rail`, on by default).
- `SegmentedControl` — a value: `role="radiogroup"` / `role="radio"` /
  `aria-checked`, no hairline of its own, 12px by default.
- `OptionRule` — the idiom's one painted element, exported on its own for a
  strip that must keep its own markup (a Radix `RadioGroup.Item` a tooltip has
  to wrap).

Option fields: `value`, `label`, `count`, `countName`, `icon`, `mark`, `name`,
`slot`, `id`, `controls`, `disabled`. Strip props: `value`, `options`,
`onChange`, `label`/`labelledBy`, `stretch`, `size`, `disabled`, `wrap`,
`busy`, `rail`, `className`.

**Keyboard** (matching `elements/reasoning-effort.tsx`, the canonical
radiogroup in `docs/ux-elements.md`): one tab stop per group — the selected
option, or the first working one when nothing is selected yet — arrows move
*and* select, Home/End jump to the ends, disabled options are stepped over, and
focus moves before `onChange` so an asynchronous change (the sessions tabs open
a conversation) cannot strand it. Two deliberate differences from that file,
both to match what the rest of the app already does: the selection **wraps**
(`settings/appearance/controls.tsx` wraps, and `test/direction.test.tsx` pins
it), and the axis mapping is APG's — Right/Down forward, Left/Up back, through
`useLogicalArrowKeys` so RTL is resolved once.

`role="tab"` with arrow-key selection is the "selection follows focus" tab
pattern, which is what these tabs have always done (switching tab opens the
destination); no tab here has an expensive-to-load panel that would ask for the
manual-activation variant.

No new token was added. Everything comes from existing ones: `--ink`,
`--ink-2`, `--ink-3`, `--surface-2`, `--line` (through `hairline-b`), `--live`
(focus), `--motion-instant`, `--motion-fast`, the `typed` and `tnum`
utilities, and the spacing/size scale. Nothing to map in a theme.

**Why not an assistant-ui element.** `docs/ux-elements.md` claims no element
for a tab strip or a segmented control; the registry's `tabs` is the shared
shadcn/Radix wrapper other elements depend on, and it ships exactly the
track-and-pill this change removes. This repo's home for that family of
primitives is `components/ui/*` (`button`, `toggle`, `badge`, …), which is
where it went.

## 3 · What the sidebar tabs now tell a developer

`Chat 2 · Code 17`, where each number is the same total the panel header used
to print — every conversation the tab lists, from the catalog totals when the
host has them and the loaded rows otherwise, for **both** tabs, including the
one you are not looking at. So the row answers "is there anything over there?"
without switching, and switching is an informed act rather than a look.

- The number is a mono tabular figure (`typed`, 12px) beside a 13px sans label:
  the product's own pairing of word and value.
- A zero is drawn. "Chat 0" is information, and a count that appears from
  nowhere would move the row.
- The accessible name carries the count with its noun — "Chat, 2 chats",
  "Code, 17 sessions", and "Chat, 2 chats, Waiting for you" when the hidden
  tab's conversation needs an answer.
- The activity mark (the existing `StatusDot`, unchanged) is its own block
  after the label and the count, so it can appear without moving the word a
  person is reading.
- The panel header lost its duplicate number; it now reads "Sessions" alone.
  The count belongs to the list it counts.

The old full-width grey track is gone: the two tabs sit at the start of the
row, under the header's hairline and on their own.

## 4 · Every call site checked

| surface | what it was | what happened |
| --- | --- | --- |
| `shell/SessionsPanel.tsx` — `Chat \| Code` | grey track, white pill, `shadow-float-sm`, own keyboard | rebuilt on `Tabs`, with counts for both tabs; header count removed |
| `settings/appearance/controls.tsx` — `Segmented` | grey track + white pill, own keyboard, `rAF` focus | now the label/specimen/detail frame around `SegmentedControl`; its public API (`label`, `value`, `options`, `onChange`, `children`, `disabled`, per-option `detail`) is unchanged, so `AppearanceTab` and `ProjectsTab` did not move |
| `workbench/SettingsScopeControls.tsx` — Global/Project/Effective | grey track + white pill | restyled to the idiom with `OptionRule`; markup stays Radix's because each option owes a tooltip, and its async scope guard keeps its own focus handling |
| `elements/reasoning-effort.tsx` — thinking levels | `field` track, `rounded-full` pill, `shadow-float-sm` **inside a popover** | restyled to the idiom (`OptionRule`), keyboard and API untouched — it stays the canonical radiogroup `docs/ux-elements.md` points at; gained `pointer-coarse:min-h-11` |
| `settings/AdvancedTab.tsx` — Resources/Configuration | ghost buttons, `bg-surface-2` when selected, **no arrow keys, no roving tabindex** | now `Tabs`; gained the keyboard it never had |
| `settings/mcp/McpInspector.tsx` — five inspector tabs | ghost buttons + a hand-written `moveTab` | now `Tabs`; `moveTab` deleted, `overflow-x-auto` kept at the call site |
| `settings/TrustTab.tsx` — Trust/Decline | grey track + coloured pills, **no arrow keys, and no tab stop at all while nothing was decided** | now `SegmentedControl`; the decision's ok/danger tone stays on the headline above, which already carries it |
| `fleet/FleetFilters.tsx` — Going/Asking/Ended, All/Agents/Commands | chips | **not touched** (another worker owns the fleet column). The control it will consume is the one above: `SegmentedControl` supports its shape — `count` per option and `slot` for each chip's `data-slot` |
| `source-control/tabs.tsx` — open files | own `border-b` tabs | **not touched** (another worker) |
| `onboarding/SetupCard.tsx` | `role="tablist"` of step dots, not a control | left alone: it has no labels and nothing to select |
| `agents/page/InstructionTemplateEditor.tsx`, `settings/mcp/McpServerForm.tsx`, `settings/mcp/McpImportDialog.tsx` | `aria-pressed` toggle groups on a track | left alone: they are toggle buttons, not a tablist or a radiogroup, and a filled ground is the right affordance for "pressed". Worth revisiting when their owners next touch them |

## 5 · Tests

`packages/ui/test/ui/tabs.test.tsx` (10 tests, jsdom/happy-dom, pointer **and**
keyboard): the paint of the idiom (rule present/absent, no track, no float
shadow, ink levels), counts and the `999+` clamp, pointer selection reported
once, the roving tabindex, Arrow/Home/End including wrapping and both axes,
stepping over a disabled option, an inert disabled group, a reachable group
with nothing selected yet (the trust case), the label not moving when a mark
appears, and the tablist's panel wiring. Plus the radiogroup role end to end.

Updated deliberately, because they asserted the old markup:

- `test/shell/sessions-tabs.test.tsx` — `[data-tab=…]` → `[data-option=…]`;
  the tab accessible names now carry their count ("Chat, 2 chats"); one new
  test pins both counts, the header no longer repeating the number, and the
  rule/no-track idiom.
- `test/shell/move-session-dialog.test.tsx` — the same one-line selector.
- `test/browser/chat-landing.mjs` — tabs are matched by `/^Chat\b/` rather than
  an exact name (the name now contains the count), and the label box it
  measures is `[data-slot="tab-label"]`. **Not run here** (the task forbids
  Playwright and `scripts/browser-check`); the assertions it makes still hold
  by construction — the mark is out of the label block, so the label cannot
  shift when activity arrives.
