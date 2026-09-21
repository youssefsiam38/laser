/**
 * The neutral foundation (M21-T14).
 *
 * `docs/design-phase.md` says Foundation proposals run on the Design-index
 * profile. A machine with no profile connected still has to answer, and the
 * two dishonest answers are an empty wizard and a "proposal" pretending a
 * model wrote it. So this file is the third answer: a complete, deliberately
 * unopinionated foundation, written here in the open, handed over with the
 * note that says exactly where it came from.
 *
 * It is neutral in the way a blank page is neutral, not in the way a
 * compromise is: greys with one accent hue, a modular type scale, a 4px
 * rhythm, motion in the tens of milliseconds, WCAG AA as the floor and the
 * eleven core components' contracts. Every value is a *token*, so the first
 * thing a person does with it — change the accent, change the rhythm — moves
 * everything that rests on it.
 *
 * Nothing in here is a fact about the person's product. Every step it fills
 * in is recorded with `source: "fallback"` and the honest note, and stays
 * `proposed` until Build implements it.
 */
import {
  PRODUCT_DISPLAY_NAME,
} from "@lasercode/protocol";
import type {
  DesignFoundation,
  DesignTokenGroup,
  FoundationComponentContract,
  FoundationScaleStep,
  FoundationSource,
  FoundationTypeStep,
} from "@lasercode/protocol";
import { checkSource, KNOWN_SOURCES } from "./licence.js";

/** The sentence a fallback step carries, wherever it is shown. */
export const FOUNDATION_FALLBACK_NOTE =
  `No model profile is connected for design work, so this is ${PRODUCT_DISPLAY_NAME}'s own neutral starting point rather than a proposal about your product. Change anything here — it is all tokens — or connect a design profile in Settings and ask for it again.`;

/** The sentence a step carries when the model answered with nothing usable. */
export const FOUNDATION_MODEL_FALLBACK_NOTE =
  `The models assigned to design work did not answer with a usable proposal, so this step holds ${PRODUCT_DISPLAY_NAME}'s own neutral starting point. Edit it, or ask for it again.`;

function token(value: string | number, type: string, description?: string): { $value: string | number; $type: string; $description?: string } {
  return { $value: value, $type: type, ...(description !== undefined ? { $description: description } : {}) };
}

/** The raw palette and base measures every semantic name points at. */
export const NEUTRAL_PRIMITIVE_TOKENS: DesignTokenGroup = {
  color: {
    neutral: {
      "0": token("#ffffff", "color"),
      "50": token("#f7f7f8", "color"),
      "100": token("#eeeef1", "color"),
      "200": token("#dcdce2", "color"),
      "300": token("#b9b9c4", "color"),
      "500": token("#6f6f80", "color"),
      "700": token("#43434f", "color"),
      "900": token("#1e1e26", "color"),
      "950": token("#121217", "color"),
    },
    accent: {
      "100": token("#dfe7ff", "color"),
      "500": token("#3b62d6", "color"),
      "700": token("#2b47a0", "color"),
    },
    positive: { "500": token("#1f7a4d", "color") },
    caution: { "500": token("#8a5a00", "color") },
    critical: { "500": token("#b3261e", "color") },
  },
  font: {
    family: {
      sans: token("Inter, system-ui, sans-serif", "fontFamily"),
      mono: token("JetBrains Mono, ui-monospace, monospace", "fontFamily"),
    },
    weight: { regular: token(400, "fontWeight"), medium: token(500, "fontWeight"), semibold: token(600, "fontWeight") },
  },
  base: {
    size: token("16px", "dimension", "The root text size every step of the scale is derived from."),
    unit: token("4px", "dimension", "The rhythm every spacing and radius step is a multiple of."),
  },
};

/** The names the product uses, aliased to the primitives above. */
export const NEUTRAL_SEMANTIC_TOKENS: DesignTokenGroup = {
  color: {
    bg: token("{color.neutral.0}", "color", "The page behind everything."),
    surface: token("{color.neutral.50}", "color", "Cards, panels, sheets."),
    "surface-raised": token("{color.neutral.100}", "color", "Inset fields and raised rows."),
    line: token("{color.neutral.200}", "color", "Hairlines and borders."),
    ink: token("{color.neutral.900}", "color", "Primary text."),
    "ink-muted": token("{color.neutral.700}", "color", "Secondary text."),
    "ink-subtle": token("{color.neutral.500}", "color", "Tertiary text and captions."),
    accent: token("{color.accent.500}", "color", "The product's one deliberate colour."),
    "on-accent": token("{color.neutral.0}", "color", "Text printed on the accent."),
    positive: token("{color.positive.500}", "color", "Something finished well."),
    caution: token("{color.caution.500}", "color", "Something needs a person."),
    critical: token("{color.critical.500}", "color", "Something failed."),
    focus: token("{color.accent.500}", "color", "The focus ring."),
  },
};

/** Dark mode, as an overlay on the same semantic names. */
export const NEUTRAL_DARK_MODE: DesignTokenGroup = {
  color: {
    bg: token("{color.neutral.950}", "color"),
    surface: token("{color.neutral.900}", "color"),
    "surface-raised": token("{color.neutral.700}", "color"),
    line: token("{color.neutral.700}", "color"),
    ink: token("{color.neutral.50}", "color"),
    "ink-muted": token("{color.neutral.200}", "color"),
    "ink-subtle": token("{color.neutral.300}", "color"),
    accent: token("{color.accent.100}", "color"),
    "on-accent": token("{color.neutral.950}", "color"),
  },
};

export const NEUTRAL_TYPE_SCALE: readonly FoundationTypeStep[] = [
  { name: "display", size: "32px", lineHeight: "40px", weight: "600", tracking: "-0.01em", usage: "One per screen, at most: the thing the page is about." },
  { name: "title", size: "24px", lineHeight: "32px", weight: "600", usage: "Section headings." },
  { name: "subtitle", size: "18px", lineHeight: "26px", weight: "500", usage: "Card and dialog headings." },
  { name: "body", size: "16px", lineHeight: "24px", weight: "400", usage: "Everything a person reads at length." },
  { name: "body-small", size: "14px", lineHeight: "20px", weight: "400", usage: "Dense rows, secondary copy." },
  { name: "caption", size: "12px", lineHeight: "16px", weight: "400", usage: "Labels and metadata. Nothing goes below this." },
];

export const NEUTRAL_SPACING: readonly FoundationScaleStep[] = [
  { name: "0", value: "0px" },
  { name: "1", value: "4px", description: "The unit. Inside a control." },
  { name: "2", value: "8px", description: "Between a label and its field." },
  { name: "3", value: "12px", description: "Inside a card." },
  { name: "4", value: "16px", description: "Between related blocks." },
  { name: "6", value: "24px", description: "Between sections." },
  { name: "8", value: "32px" },
  { name: "12", value: "48px", description: "Page gutters." },
];

export const NEUTRAL_RADIUS: readonly FoundationScaleStep[] = [
  { name: "sm", value: "4px", description: "Inputs, chips." },
  { name: "md", value: "8px", description: "Buttons, cards." },
  { name: "lg", value: "12px", description: "Dialogs, sheets." },
  { name: "full", value: "999px", description: "Pills and avatars." },
];

export const NEUTRAL_SHADOW: readonly FoundationScaleStep[] = [
  { name: "raised", value: "0 1px 2px rgba(18,18,23,0.08)", description: "A row lifted off the page." },
  { name: "overlay", value: "0 8px 24px rgba(18,18,23,0.16)", description: "Menus and popovers." },
  { name: "dialog", value: "0 16px 48px rgba(18,18,23,0.24)", description: "Modal surfaces." },
];

export const NEUTRAL_Z_INDEX: readonly FoundationScaleStep[] = [
  { name: "base", value: "0" },
  { name: "sticky", value: "10", description: "Headers that stay." },
  { name: "overlay", value: "20", description: "Menus, popovers, tooltips." },
  { name: "dialog", value: "30" },
  { name: "toast", value: "40", description: "Above everything, never over a dialog's own actions." },
];

export const NEUTRAL_MOTION: NonNullable<DesignFoundation["motion"]> = {
  durations: [
    { name: "instant", value: "80ms", description: "A state change on something under the pointer." },
    { name: "fast", value: "140ms", description: "Opening a menu, revealing a row." },
    { name: "normal", value: "220ms", description: "A panel or a dialog." },
    { name: "slow", value: "360ms", description: "A full-screen transition. Rare." },
  ],
  easings: [
    { name: "standard", value: "cubic-bezier(0.2, 0, 0, 1)", description: "Things that move within the screen." },
    { name: "enter", value: "cubic-bezier(0.05, 0.7, 0.1, 1)", description: "Things arriving." },
    { name: "exit", value: "cubic-bezier(0.3, 0, 0.8, 0.15)", description: "Things leaving." },
  ],
  reducedMotion:
    "Under prefers-reduced-motion every transform and every duration collapses to an opacity change of 0ms–80ms. Nothing disappears, nothing is skipped: the movement goes, the state change stays.",
};

export const NEUTRAL_LAYOUT_RULES: readonly string[] = [
  "One page frame: a header that stays, an optional navigation rail, and one scrolling region for the content.",
  "Content is capped at 72 characters for prose and 1200px for dense layouts; the gutters take the rest.",
  "Breakpoints are content-led: one column below 640px, a rail from 900px, a second panel from 1200px.",
  "A component that cannot fit shows less content, never smaller text.",
  "Vertical rhythm is the spacing scale: nothing between two steps, ever.",
];

export const NEUTRAL_ACCESSIBILITY: NonNullable<DesignFoundation["accessibility"]> = {
  contrastMin: 4.5,
  minFontPx: 12,
  focusVisible: "A two-pixel focus ring in the focus colour, offset by two pixels, on every interactive element, in both modes.",
  targetMinPx: 24,
  rules: [
    "Every control reachable and operable from the keyboard, in the order it reads.",
    "Colour is never the only carrier of meaning: status has a word or a shape beside it.",
    "Every image and icon that means something has a name; decorative ones are hidden from assistive technology.",
    "Motion respects prefers-reduced-motion; nothing auto-plays.",
    "Text can be zoomed to 200% without loss of content or horizontal scrolling.",
  ],
};

export const NEUTRAL_COMPONENTS: readonly FoundationComponentContract[] = [
  {
    name: "Button",
    purpose: "The one thing this screen wants a person to do, and its alternatives.",
    variants: ["primary", "secondary", "ghost", "danger"],
    sizes: ["sm", "md"],
    states: ["default", "hover", "active", "focus", "disabled", "loading"],
    accessibility: "A real button element with an accessible name; loading keeps the name and announces busy.",
  },
  {
    name: "Input",
    purpose: "One value a person types.",
    variants: ["default", "inline"],
    sizes: ["sm", "md"],
    slots: ["label", "help", "error", "prefix", "suffix"],
    states: ["default", "focus", "error", "disabled", "read-only"],
    accessibility: "Label always present and programmatically associated; the error is announced and never colour alone.",
  },
  {
    name: "Select",
    purpose: "One value from a closed list.",
    variants: ["default", "inline"],
    sizes: ["sm", "md"],
    slots: ["label", "help", "error"],
    states: ["default", "open", "focus", "disabled"],
    accessibility: "Keyboard-operable listbox semantics; the current value is announced on open.",
  },
  {
    name: "Checkbox",
    purpose: "A binary choice, or several of them.",
    variants: ["default"],
    states: ["unchecked", "checked", "indeterminate", "focus", "disabled"],
    accessibility: "The label is the target as well as the text; indeterminate is announced as mixed.",
  },
  {
    name: "Card",
    purpose: "One thing, with its own heading, body and actions.",
    variants: ["plain", "raised", "interactive"],
    slots: ["header", "body", "footer", "media"],
    states: ["default", "hover", "selected"],
    accessibility: "An interactive card has exactly one primary action; the whole card is not a link around other links.",
  },
  {
    name: "Dialog",
    purpose: "One decision, taken away from the page behind it.",
    variants: ["modal", "sheet"],
    sizes: ["sm", "md", "lg"],
    slots: ["title", "body", "actions"],
    states: ["open", "closing"],
    accessibility: "Focus is trapped and restored, Escape closes, the title names the dialog, Enter never takes a destructive action.",
  },
  {
    name: "Toast",
    purpose: "Something happened that a person did not ask to be told twice.",
    variants: ["info", "success", "warning", "error"],
    states: ["entering", "shown", "leaving"],
    accessibility: "A polite live region; an error toast is assertive and stays until dismissed.",
  },
  {
    name: "Nav",
    purpose: "Where a person is, and where else they can go.",
    variants: ["rail", "tabs", "breadcrumbs"],
    states: ["default", "current", "hover", "focus"],
    accessibility: "The current item carries aria-current; the rail is a landmark with a name.",
  },
  {
    name: "Table",
    purpose: "Many things of the same kind, compared.",
    variants: ["plain", "striped", "dense"],
    slots: ["header", "row", "footer", "empty"],
    states: ["default", "sorted", "selected", "loading"],
    accessibility: "Real table semantics with header cells; sorting is a button in the header and announces its direction.",
  },
  {
    name: "Empty",
    purpose: "There is nothing here yet, and this is what to do about it.",
    variants: ["first-run", "filtered", "cleared"],
    slots: ["title", "detail", "action"],
    states: ["default"],
    accessibility: "The explanation is text, not an illustration; the action is reachable by keyboard.",
  },
  {
    name: "Error",
    purpose: "What went wrong, and what to do next — written for a person.",
    variants: ["inline", "page", "offline"],
    slots: ["title", "detail", "retry"],
    states: ["default", "retrying"],
    accessibility: "Announced when it appears; retry keeps focus where the person was.",
  },
  {
    name: "Loading",
    purpose: "Something is happening, and roughly how much of it is left.",
    variants: ["inline", "skeleton", "page"],
    states: ["indeterminate", "progress"],
    accessibility: "Announced politely once, never on every tick; skeletons are hidden from assistive technology.",
  },
];

export const NEUTRAL_PRINCIPLES: readonly string[] = [
  "One deliberate colour. Everything else is a grey, so the one that is not carries meaning.",
  "Legibility is a floor, not a preference: nothing below the caption size, nothing that clips.",
  "Every state is designed — empty, loading, error and first run get the same care as the happy path.",
  "Motion explains a change; it never announces itself.",
  "Density serves the content: the same screen may be comfortable or compact, never smaller text.",
];

/** The sources the neutral foundation proposes, each already licence-checked. */
export function neutralSources(): FoundationSource[] {
  return ["lucide", "inter", "jetbrains-mono"].flatMap((id) => {
    const candidate = KNOWN_SOURCES.find((entry) => entry.id === id);
    return candidate ? [checkSource(candidate)] : [];
  });
}

/** The whole neutral foundation, with nothing accepted yet. */
export function neutralFoundation(): DesignFoundation {
  return {
    principles: [...NEUTRAL_PRINCIPLES],
    status: "proposed",
    steps: [],
    tokens: mergeTokens(NEUTRAL_PRIMITIVE_TOKENS, NEUTRAL_SEMANTIC_TOKENS),
    modes: [
      { name: "light", tokens: NEUTRAL_SEMANTIC_TOKENS, description: "The default mode." },
      { name: "dark", tokens: NEUTRAL_DARK_MODE, description: "The same semantic names, over the dark end of the ramp." },
    ],
    typeScale: [...NEUTRAL_TYPE_SCALE],
    scales: {
      spacing: [...NEUTRAL_SPACING],
      radius: [...NEUTRAL_RADIUS],
      shadow: [...NEUTRAL_SHADOW],
      zIndex: [...NEUTRAL_Z_INDEX],
    },
    motion: NEUTRAL_MOTION,
    sources: neutralSources(),
    layoutRules: [...NEUTRAL_LAYOUT_RULES],
    accessibility: NEUTRAL_ACCESSIBILITY,
    components: [...NEUTRAL_COMPONENTS],
  };
}

/** Deep-merge two DTCG documents, right-hand wins at the leaf. */
export function mergeTokens(left: DesignTokenGroup, right: DesignTokenGroup): DesignTokenGroup {
  const merged: DesignTokenGroup = { ...left };
  for (const [name, node] of Object.entries(right)) {
    const existing = merged[name];
    if (existing !== undefined && isGroup(existing) && isGroup(node)) merged[name] = mergeTokens(existing, node);
    else merged[name] = node;
  }
  return merged;
}

function isGroup(node: unknown): node is DesignTokenGroup {
  return node !== null && typeof node === "object" && !("$value" in (node as Record<string, unknown>));
}
