/**
 * The primitive kit — the components a design is drawn from (M21-T11, D-354).
 *
 * The Design phase never runs the project (D-353), so nothing on the canvas is
 * the project's real component. What the canvas draws is **this app's kit,
 * skinned by the project's index**: the contract each component records
 * (variants, slots, sizes, density) rendered by this app's own primitives,
 * with the index's tokens as the only source of colour, size, radius, shadow
 * and motion. That facsimile is exactly what `Mapped` means, and the kit is a
 * first-class deliverable held to this app's own UI bar.
 *
 * This file is the kit's *contract*: what exists, what each one accepts, which
 * ones hold children. The renderer (`components/design/kit/`) draws it and
 * `kit-css.ts` skins it; the inspector offers exactly what is listed here, so
 * a design can never carry a prop the renderer would ignore.
 */

export type KitPropKind = "text" | "boolean" | "number" | "token" | "choice" | "fixture" | "asset";

export interface KitProp {
  name: string;
  label: string;
  kind: KitPropKind;
  /** For `choice`, the values offered. */
  choices?: readonly string[];
  /** The token family a `token` prop should come from, for the picker. */
  tokenFamily?: string;
  /** One line, shown under the field in the inspector. */
  hint?: string;
}

export interface KitPrimitive {
  name: string;
  label: string;
  /** What it is for, in the inspector's header. */
  purpose: string;
  props: readonly KitProp[];
  variants: readonly string[];
  /** Interaction states the prototype may switch this node into. */
  states: readonly string[];
  /** True when children may be dropped into it and reordered. */
  container: boolean;
  /** True when the node's own `text` is its content, editable inline. */
  inlineText: boolean;
}

const TEXT_PROP: KitProp = { name: "label", label: "Label", kind: "text" };
const TONE: readonly string[] = ["info", "ok", "attention", "danger"];

export const KIT: readonly KitPrimitive[] = [
  {
    name: "stack",
    label: "Stack",
    purpose: "Lays its children out in one direction with one rhythm.",
    props: [
      { name: "gap", label: "Gap", kind: "token", tokenFamily: "space", hint: "A spacing token from the index." },
      { name: "align", label: "Align", kind: "choice", choices: ["start", "center", "end", "stretch"] },
      { name: "padded", label: "Padded", kind: "boolean" },
    ],
    variants: ["column", "row"],
    states: [],
    container: true,
    inlineText: false,
  },
  {
    name: "grid",
    label: "Grid",
    purpose: "Lays its children out in columns.",
    props: [
      { name: "columns", label: "Columns", kind: "number" },
      { name: "gap", label: "Gap", kind: "token", tokenFamily: "space" },
    ],
    variants: ["even", "sidebar"],
    states: [],
    container: true,
    inlineText: false,
  },
  {
    name: "text",
    label: "Text",
    purpose: "Words. Headings, body copy, captions and eyebrows.",
    props: [{ name: "color", label: "Colour", kind: "token", tokenFamily: "color" }],
    variants: ["body", "heading", "subheading", "caption", "eyebrow"],
    states: [],
    container: false,
    inlineText: true,
  },
  {
    name: "button",
    label: "Button",
    purpose: "The one thing this screen wants a person to do, and its alternatives.",
    props: [TEXT_PROP, { name: "href", label: "Goes to", kind: "text", hint: "A path in the product, or an https address." }],
    variants: ["primary", "secondary", "ghost", "danger"],
    states: ["default", "hover", "disabled", "loading"],
    container: false,
    inlineText: true,
  },
  {
    name: "input",
    label: "Input",
    purpose: "One value a person types.",
    props: [
      TEXT_PROP,
      { name: "placeholder", label: "Placeholder", kind: "text" },
      { name: "value", label: "Value", kind: "text" },
      { name: "help", label: "Help", kind: "text" },
    ],
    variants: ["default", "inline"],
    states: ["default", "focus", "error", "disabled"],
    container: false,
    inlineText: false,
  },
  {
    name: "select",
    label: "Select",
    purpose: "One value from a closed list.",
    props: [TEXT_PROP, { name: "value", label: "Value", kind: "text" }, { name: "options", label: "Options", kind: "fixture", hint: "A fixture supplies the list." }],
    variants: ["default", "inline"],
    states: ["default", "open", "disabled"],
    container: false,
    inlineText: false,
  },
  {
    name: "checkbox",
    label: "Checkbox",
    purpose: "One thing on or off.",
    props: [TEXT_PROP, { name: "checked", label: "Checked", kind: "boolean" }],
    variants: ["default", "switch"],
    states: ["default", "disabled"],
    container: false,
    inlineText: false,
  },
  {
    name: "card",
    label: "Card",
    purpose: "A panel that groups what belongs together.",
    props: [{ name: "title", label: "Title", kind: "text" }, { name: "subtitle", label: "Subtitle", kind: "text" }],
    variants: ["default", "quiet", "elevated"],
    states: [],
    container: true,
    inlineText: false,
  },
  {
    name: "dialog",
    label: "Dialog",
    purpose: "A decision on top of the screen behind it.",
    props: [{ name: "title", label: "Title", kind: "text" }, { name: "description", label: "Description", kind: "text" }],
    variants: ["default", "destructive"],
    states: ["open"],
    container: true,
    inlineText: false,
  },
  {
    name: "toast",
    label: "Toast",
    purpose: "What just happened, briefly.",
    props: [{ name: "title", label: "Title", kind: "text" }, { name: "detail", label: "Detail", kind: "text" }],
    variants: TONE,
    states: ["visible"],
    container: false,
    inlineText: false,
  },
  {
    name: "nav",
    label: "Nav",
    purpose: "Where a person can go from here.",
    props: [{ name: "items", label: "Items", kind: "fixture" }],
    variants: ["horizontal", "vertical", "tabs"],
    states: [],
    container: true,
    inlineText: false,
  },
  {
    name: "table",
    label: "Table",
    purpose: "Rows of one shape, compared.",
    props: [
      { name: "columns", label: "Columns", kind: "fixture" },
      { name: "rows", label: "Rows", kind: "fixture" },
      { name: "density", label: "Density", kind: "choice", choices: ["comfortable", "compact"] },
    ],
    variants: ["default", "striped"],
    states: ["default", "loading", "empty", "error"],
    container: false,
    inlineText: false,
  },
  {
    name: "empty",
    label: "Empty state",
    purpose: "Nothing here yet, and what to do about it.",
    props: [{ name: "title", label: "Title", kind: "text" }, { name: "detail", label: "Detail", kind: "text" }],
    variants: ["default"],
    states: [],
    container: false,
    inlineText: false,
  },
  {
    name: "loading",
    label: "Loading state",
    purpose: "Work in flight, said in words.",
    props: [{ name: "label", label: "Label", kind: "text" }],
    variants: ["default", "inline"],
    states: [],
    container: false,
    inlineText: false,
  },
  {
    name: "error",
    label: "Error state",
    purpose: "What went wrong, and what to do next.",
    props: [{ name: "title", label: "Title", kind: "text" }, { name: "detail", label: "Detail", kind: "text" }],
    variants: ["default", "inline"],
    states: [],
    container: false,
    inlineText: false,
  },
  {
    name: "image",
    label: "Image",
    purpose: "A picture, from the project's own assets.",
    props: [
      { name: "alt", label: "Alternative text", kind: "text", hint: "What the picture says, for someone who cannot see it." },
      { name: "asset", label: "Asset", kind: "asset" },
      { name: "ratio", label: "Ratio", kind: "choice", choices: ["16/9", "4/3", "1/1", "3/4"] },
    ],
    variants: ["default", "rounded", "cover"],
    states: ["default", "loading", "missing"],
    container: false,
    inlineText: false,
  },
] as const;

export const KIT_NAMES: readonly string[] = KIT.map((primitive) => primitive.name);

export function kitPrimitive(name: string): KitPrimitive | undefined {
  return KIT.find((primitive) => primitive.name === name);
}

/** The label a surface shows for a node's component, index entry or primitive. */
export function kitLabel(name: string): string {
  return kitPrimitive(name)?.label ?? name;
}

/**
 * Which primitive draws an index entry.
 *
 * A node composed from the index names an entry, not a primitive: the design
 * says "this is the project's `PrimaryButton`", and the canvas has to draw
 * something. Since the Design phase never runs the project (D-353), what it
 * draws is the kit component whose contract matches the entry's — the
 * facsimile `Mapped` means. The match is by the entry's own name, because that
 * is the one fact every index entry has; anything more specific comes from the
 * entry's recorded contract, which the caller passes in.
 *
 * `card` is the fallback rather than `text`: an unrecognised component is
 * usually a container, and a container that draws its children is more honest
 * than one that silently drops them.
 */
export function kitNameForEntry(entryName: string, detail?: Readonly<Record<string, string>>): string {
  const hinted = detail?.["primitive"] ?? detail?.["kit"];
  if (hinted && KIT_NAMES.includes(hinted)) return hinted;
  const name = entryName.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/(button|cta|action|link|anchor)/, "button"],
    [/(textarea|input|field|textbox|search)/, "input"],
    [/(select|dropdown|combobox|picker)/, "select"],
    [/(checkbox|toggle|switch|radio)/, "checkbox"],
    [/(dialog|modal|sheet|drawer)/, "dialog"],
    [/(toast|snackbar|alert|banner|notice)/, "toast"],
    [/(nav|menu|tabs|breadcrumb|sidebar)/, "nav"],
    [/(table|datagrid|list|rows)/, "table"],
    [/(image|avatar|icon|thumbnail|logo)/, "image"],
    [/(grid|columns)/, "grid"],
    [/(stack|box|flex|row|column|layout|container)/, "stack"],
    [/(heading|title|label|text|paragraph|caption)/, "text"],
    [/(empty|placeholder)/, "empty"],
    [/(spinner|loading|skeleton)/, "loading"],
    [/(error|failure)/, "error"],
    [/(card|panel|tile|well)/, "card"],
  ];
  for (const [pattern, primitive] of rules) {
    if (pattern.test(name)) return primitive;
  }
  return "card";
}
