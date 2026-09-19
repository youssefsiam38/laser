/**
 * The one measurement a headless DOM cannot give the fleet column: width.
 *
 * Two of the column's claims are widths, not heights — the filter row fits
 * inside its column with every control whole, and both kinds of row start
 * their title in the same place — and happy-dom lays nothing out, so
 * `scrollWidth`, `clientWidth` and `getBoundingClientRect()` are all zero.
 * Asserting either claim from class names would be asserting the source back
 * to itself: `px-1.5` proves nothing about whether `Commands 2` is sliced by
 * the panel border.
 *
 * So this is a small, deliberately narrow flex measurer. It understands
 * exactly the geometry utilities these two components use — padding, gap,
 * fixed sizes, `flex-1`, `flex-col`, out-of-flow children — and a text model
 * for the two faces the app ships. It is not a browser: it is a lower bound
 * on how much room the content needs, built to be *pessimistic*, so a row
 * that fits here fits in Chrome with room to spare.
 *
 * ## The text model, and why you can trust it
 *
 * Every glyph is given an advance width at or above its real one:
 *
 *   - **mono** (`eyebrow`, `typed`) is Martian Mono, whose advance is exactly
 *     0.6em on a 1000-unit em; `eyebrow` adds its 0.08em of tracking after
 *     every character, the way CSS `letter-spacing` does.
 *   - **sans** is Host Grotesk, measured per character class: 0.625em for a
 *     letter, 0.30em for a narrow one (`i j l t f r I` and punctuation),
 *     0.82em for `m w M W`, and 0.56em for a tabular digit.
 *
 * `fit.test.tsx` pins the model against the six control widths measured in
 * the running app at 320px, and requires every one of them to come out no
 * smaller than the app measured and within 5px of it. If someone retunes a
 * ratio, that test says so.
 *
 * Nothing here is installed globally by default: `installFleetWidths()` is
 * opt-in per suite, chains to whatever descriptor was already on
 * `Element.prototype` (the thread's viewport shim lives there too), and is
 * removed by the function it returns.
 */

/** px per spacing step. `comfortable` is the default density. */
const SPACING = { comfortable: 4, compact: 3.5 } as const;

export interface FleetLayoutOptions {
  /** The border-box width the measured root is given. */
  width: number;
  /** `--text-*` scale: 1 = default, 1.1 = large, 1.2 = larger. */
  textScale?: number;
  density?: keyof typeof SPACING;
}

interface Resolved {
  width: number;
  unit: number;
  size: (step: TypeStep) => number;
}

type TypeStep = "2xs" | "xs" | "sm" | "base";

const TYPE: Record<TypeStep, number> = { "2xs": 11, xs: 12, sm: 13, base: 14 };
/** The compiler's floors: data never goes under 12, an eyebrow never under 11. */
const FLOOR: Record<TypeStep, number> = { "2xs": 11, xs: 12, sm: 12, base: 12 };

const resolve = (options: FleetLayoutOptions): Resolved => ({
  width: options.width,
  unit: SPACING[options.density ?? "comfortable"],
  size: (step) => Math.max(FLOOR[step], Math.round(TYPE[step] * (options.textScale ?? 1))),
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NARROW = new Set([..."ijltfrIÌ.,;:!|'’()[]{}/\\ ·-"]);
const WIDE = new Set([..."mwMW"]);
const DIGIT = new Set([..."0123456789"]);

interface Font {
  step: TypeStep;
  mono: boolean;
  tracking: number;
}

const ratio = (char: string, font: Font): number => {
  if (font.mono) return 0.6 + font.tracking;
  if (DIGIT.has(char)) return 0.56;
  if (NARROW.has(char)) return 0.3;
  if (WIDE.has(char)) return 0.82;
  return 0.625;
};

export const textWidth = (text: string, font: Font, size: (step: TypeStep) => number): number => {
  const em = size(font.step);
  let total = 0;
  for (const char of text) total += em * ratio(char, font);
  return total;
};

// ---------------------------------------------------------------------------
// Style, read off the class list
// ---------------------------------------------------------------------------

interface Style {
  padStart: number;
  padEnd: number;
  gap: number;
  fixed: number | undefined;
  column: boolean;
  flexible: boolean;
  outOfFlow: boolean;
  hidden: boolean;
  pushed: boolean;
  font: Partial<Font>;
}

const step = (token: string, unit: number): number | undefined => {
  if (token === "px") return 1;
  if (token === "full") return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value * unit : undefined;
};

function readStyle(element: Element, unit: number): Style {
  const style: Style = {
    padStart: 0,
    padEnd: 0,
    gap: 0,
    fixed: undefined,
    column: false,
    flexible: false,
    outOfFlow: false,
    hidden: false,
    pushed: false,
    font: {},
  };
  const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  for (const raw of classes) {
    // Variants (`hover:`, `pointer-coarse:`, `@sm:`, `motion-reduce:`) never
    // describe the measured state, and a negative margin is optical.
    if (raw.includes(":") || raw.startsWith("-")) continue;
    const [name, ...rest] = raw.split("-");
    const token = rest.join("-");
    switch (name) {
      case "p": {
        const value = step(token, unit);
        if (value !== undefined) { style.padStart = value; style.padEnd = value; }
        break;
      }
      case "px": {
        const value = step(token, unit);
        if (value !== undefined) { style.padStart = value; style.padEnd = value; }
        break;
      }
      case "ps": {
        const value = step(token, unit);
        if (value !== undefined) style.padStart = value;
        break;
      }
      case "pe": {
        const value = step(token, unit);
        if (value !== undefined) style.padEnd = value;
        break;
      }
      case "gap": {
        const value = step(token, unit);
        if (value !== undefined) style.gap = value;
        break;
      }
      case "size":
      case "w": {
        if (token === "full") { style.flexible = true; break; }
        const value = step(token, unit);
        if (value !== undefined) style.fixed = value;
        break;
      }
      case "flex": {
        if (token === "col") style.column = true;
        else if (token === "1" || token === "auto") style.flexible = true;
        break;
      }
      case "absolute":
      case "fixed":
        style.outOfFlow = true;
        break;
      case "hidden":
        style.hidden = true;
        break;
      case "ms":
        if (token === "auto") style.pushed = true;
        break;
      case "text":
        if (token in TYPE) style.font.step = token as TypeStep;
        break;
      case "eyebrow":
        style.font = { step: "2xs", mono: true, tracking: 0.08 };
        break;
      case "typed":
        style.font = { ...style.font, step: style.font.step ?? "xs", mono: true, tracking: 0 };
        break;
      case "tracking":
        if (token === "normal") style.font.tracking = 0;
        break;
      case "sr":
        if (token === "only") style.hidden = true;
        break;
      default:
        break;
    }
  }
  return style;
}

const inherit = (font: Font, own: Partial<Font>): Font => ({
  step: own.step ?? font.step,
  mono: own.mono ?? font.mono,
  tracking: own.tracking ?? (own.mono === undefined ? font.tracking : 0),
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Box {
  x: number;
  width: number;
}

const flowChildren = (element: Element, unit: number): Element[] =>
  [...element.children].filter((child) => {
    const style = readStyle(child, unit);
    return !style.outOfFlow && !style.hidden;
  });

/** The text this element carries itself, outside any child element. */
const ownText = (element: Element): string =>
  [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join("");

function natural(element: Element, font: Font, context: Resolved): number {
  const style = readStyle(element, context.unit);
  const own = inherit(font, style.font);
  if (style.fixed !== undefined) return style.fixed;
  // An icon is a leaf: its children are path data, not boxes. The menu's own
  // rule sizes an unsized icon at 16px.
  if (element.tagName.toLowerCase() === "svg") return 16;
  const children = flowChildren(element, context.unit);
  const text = textWidth(ownText(element).trim(), own, context.size);
  let content: number;
  if (children.length === 0) content = text;
  else if (style.column) content = Math.max(...children.map((child) => natural(child, own, context)));
  else {
    content = children.reduce((sum, child) => sum + natural(child, own, context), 0) + style.gap * (children.length - 1);
    content += text;
  }
  return style.padStart + style.padEnd + content;
}

/**
 * Lay a subtree out inside a known box and record every element's position.
 * The root's own box is the width it was given; everything below it is placed
 * left to right (the suites that use this are LTR), with `flex-1` children
 * taking what is left.
 */
export function layout(root: Element, options: FleetLayoutOptions): Map<Element, Box> {
  const context = resolve(options);
  const boxes = new Map<Element, Box>();
  const place = (element: Element, box: Box, font: Font): void => {
    boxes.set(element, box);
    if (element.tagName.toLowerCase() === "svg") return;
    const style = readStyle(element, context.unit);
    const own = inherit(font, style.font);
    const children = flowChildren(element, context.unit);
    if (children.length === 0) return;
    const inner = box.width - style.padStart - style.padEnd;
    if (style.column) {
      for (const child of children) {
        const width = readStyle(child, context.unit).flexible ? inner : Math.min(inner, natural(child, own, context));
        place(child, { x: box.x + style.padStart, width }, own);
      }
      return;
    }
    const sizes = children.map((child) => natural(child, own, context));
    const gaps = style.gap * (children.length - 1);
    const flexible = children.map((child) => readStyle(child, context.unit).flexible);
    const fixedTotal = sizes.reduce((sum, size, index) => sum + (flexible[index] ? 0 : size), 0);
    const spare = Math.max(0, inner - fixedTotal - gaps);
    const flexCount = flexible.filter(Boolean).length;
    let x = box.x + style.padStart;
    children.forEach((child, index) => {
      const width = flexible[index] ? spare / flexCount : sizes[index]!;
      place(child, { x, width }, own);
      x += width + style.gap;
    });
  };
  place(root, { x: 0, width: options.width }, { step: "xs", mono: false, tracking: 0 });
  return boxes;
}

/** What the browser would report for a scroller of this width. */
export function overflow(root: Element, options: FleetLayoutOptions): { clientWidth: number; scrollWidth: number } {
  const context = resolve(options);
  const style = readStyle(root, context.unit);
  const children = flowChildren(root, context.unit);
  const font: Font = { step: "xs", mono: false, tracking: 0 };
  const content =
    children.reduce((sum, child) => sum + natural(child, font, context), 0) + style.gap * Math.max(0, children.length - 1);
  return {
    clientWidth: options.width,
    scrollWidth: Math.max(options.width, Math.ceil(style.padStart + content + style.padEnd)),
  };
}

// ---------------------------------------------------------------------------
// The prototype shim
// ---------------------------------------------------------------------------

/**
 * Make `clientWidth` and `scrollWidth` real for the elements a selector picks
 * out, so a component that measures itself in a layout effect measures
 * something. Returns the undo.
 */
export function installFleetWidths(selector: string, options: FleetLayoutOptions): () => void {
  // happy-dom puts `clientWidth` on HTMLElement and `scrollWidth` on Element.
  // Patching only Element leaves HTMLDivElement.clientWidth at 0, so a row
  // whose content is 400px looks like 400 > 0 and the filter sheds everything.
  const protos: object[] = [Element.prototype, HTMLElement.prototype];
  const names = ["clientWidth", "scrollWidth"] as const;
  const previous: Array<{ proto: object; name: (typeof names)[number]; descriptor: PropertyDescriptor | undefined }> = [];
  for (const proto of protos) {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      previous.push({ proto, name, descriptor });
      Object.defineProperty(proto, name, {
        configurable: true,
        get(this: Element) {
          if (typeof this.matches === "function" && this.matches(selector)) return overflow(this, options)[name];
          return descriptor?.get?.call(this) ?? 0;
        },
      });
    }
  }
  return () => {
    for (const { proto, name, descriptor } of previous) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else Reflect.deleteProperty(proto, name);
    }
  };
}
