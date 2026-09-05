# The theme system — every token is a variable

Status: **binding.** No component may hard-code a colour, a font, a radius, a
shadow, a duration or a spacing step. Everything visual resolves through a
token, and every token is settable by the person using the app.

## Why

piorbit is a tool people stare at for hours. The right type size, contrast
and hue are personal and situational — a bright room, a dim room, a projector,
low vision, a preference for warm greys over cool. A design system that bakes
those in is a design system that is wrong for most people most of the time.

So `packages/ui/DESIGN.md` does not describe *the* look. It describes the
**default preset**. This document describes the machinery, and the machinery
is the actual contract.

## Three layers

**1 · Primitives.** Raw scales with no meaning attached. A ramp of neutrals,
a ramp per accent hue, a type scale, a spacing scale, a radius scale, a
duration scale. Primitives are never used directly by a component.

**2 · Semantic tokens.** What a component actually reads: `--bg`,
`--surface`, `--surface-2`, `--line`, `--ink`, `--ink-2`, `--ink-3`,
`--live`, `--attention`, `--danger`, `--ok`, `--on-accent`, plus
`--font-sans`, `--font-mono`, `--text-*`, `--space-*`, `--radius-*`,
`--shadow-*`, `--motion-*`. A semantic token is assigned *from* a primitive
by the active theme.

**3 · Component tokens.** Only where a component genuinely needs its own knob
(`--composer-radius`, `--dock-width`, `--island-min-height`). Each falls back
to a semantic token, so a theme that says nothing about it still works.

A component may only ever read layer 2 or 3. A literal colour, a `px` font
size, or a raw hex in a component is a bug, and the reviewer greps for them.

## What a theme is

A theme is data, not code:

```ts
type Theme = {
  id: string;                 // "midnight", "paper", "custom"
  name: string;
  base: "dark" | "light";     // what the OS-level color-scheme reports
  tokens: Record<string, string>;   // semantic token → value
  fonts: { sans: FontChoice; mono: FontChoice };
  density: "comfortable" | "compact";
  radius: "sharp" | "soft" | "round";
  contrast: "normal" | "high";
  motion: "full" | "reduced";
};
```

Applying a theme writes those values as CSS custom properties on the root
element. Nothing recompiles, nothing re-imports, and switching is instant
because it is one style write.

## What the person can change, in Settings → Appearance

Simple choices first, depth behind a disclosure.

| Control | Choices |
| --- | --- |
| Theme | A gallery of presets, each a live swatch card. Default is a plain dark preset |
| Accent | A hue row; picking one re-derives `--live` and its on-colour for both bases |
| Attention hue | Separate from accent, because "needs you" must never be the same colour as "running" |
| Interface font | A curated list, each rendered in itself so the choice is visible |
| Code font | Same, monospace |
| Text size | Small, default, large, larger — scales the whole type scale, never one element |
| Density | Comfortable or compact — scales the spacing scale |
| Corners | Sharp, soft, round |
| Contrast | Normal or high; high raises every text token until it clears its ground |
| Motion | Full or reduced; reduced also wins if the OS says so |
| Follow the system | When on, the base flips with `prefers-color-scheme` |
| Custom | Edit any semantic token directly, with a contrast readout next to each |

Every change previews live on the real app behind the settings surface. There
is a Reset for each group and one for everything.

## Fonts

Fonts are loaded on demand from Google Fonts by family name and only when
chosen, so an unused family costs nothing. Every choice declares a real
fallback stack, and the app renders correctly before the webfont arrives —
size and weight are chosen so the swap does not reflow.

The **default interface font is Inter** and the **default code font is
JetBrains Mono**. That is a deliberate change from the first design pass:
Host Grotesk and Martian Mono are characterful but tiring at 12–13px, which
is where this app lives. Inter was drawn for exactly this size on exactly
these screens; JetBrains Mono has a tall x-height and unambiguous glyphs for
code. Both remain available as choices, so nothing is lost.

Curated interface list: Inter, IBM Plex Sans, Source Sans 3, Public Sans,
Figtree, Atkinson Hyperlegible (drawn for low vision), Host Grotesk, and the
system stack for people who want no webfont at all.

Curated code list: JetBrains Mono, IBM Plex Mono, Source Code Pro, Fira Code,
Roboto Mono, Martian Mono, and the system monospace stack.

## Rules

**T1 · No static visual values in components.** Colour, font, size, radius,
shadow, spacing and duration all come from tokens. The only literals allowed
are in the primitive scales and the preset definitions.

**T2 · The legibility floor holds in every theme.** No data below 12px at any
text-size setting; the scale multiplies, it does not shrink past the floor.
Every preset ships with a contrast check, and a custom token that fails 4.5:1
against its ground is flagged in the editor rather than silently accepted.

**T3 · Semantic meaning is fixed even when colour is not.** `--live` always
means running, `--attention` always means needs-you, `--danger` always means
error. A theme may change the hues; it may not repurpose them, and the
attention hue may never equal the accent hue.

**T4 · Themes persist where settings live**, so the same theme follows you to
the phone through the relay, and a fresh install starts on the default rather
than a half-applied custom.

**T5 · The default must be good.** Most people never open Appearance. The
default dark preset is the product's face, and it gets the same scrutiny as
if it were the only one.

**T6 · Every element restyles through tokens.** An adopted assistant-ui
element is mapped onto our semantic tokens as part of adopting it
(`docs/ux-elements.md`), never left on its own defaults. `surfaces` — the
shared vocabulary those elements build on — is mapped first.
