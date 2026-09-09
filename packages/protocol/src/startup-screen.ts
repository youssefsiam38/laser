/**
 * The opening screen, in one place (M13-T32).
 *
 * There is exactly one screen between launching and the app: the mark with the
 * beams converging into it. It is drawn twice by two very different renderers —
 * React inside the app, and a standalone document the desktop shell shows while
 * the host is still starting — and it must be the same drawing both times, or
 * the handover is a jump.
 *
 * So the composition lives here, as data, and neither renderer owns it:
 *
 *   - `startupScene()` is the element tree: the beams, their gradients, the
 *     mark, the wordmark, the label, the signal. React maps it to elements;
 *     `renderStartupNodes()` serializes the same tree to HTML.
 *   - `STARTUP_SCREEN_CSS` is every rule and keyframe the scene needs, written
 *     in tokens. The app's `globals.css` carries a copy between markers, and
 *     `packages/ui/test/startup-screen.test.ts` fails if the two disagree.
 *   - `STARTUP_SCREEN_TOKEN_NAMES` is the exact list of declarations the scene
 *     reads, so the app can hand the desktop the person's own values and the
 *     standalone page can paint in their theme rather than in a guess.
 *
 * Why this package: it is the one package both the browser bundle and the
 * Electron main process already depend on, and it imports nothing. It is
 * reached through the `./startup-screen` subpath rather than the index, so a
 * host or a relay never loads a screen it cannot draw.
 *
 * This file writes no colour, size or duration of its own. The two fallback
 * maps below are the default presets' compiled values — a preset definition,
 * which is the one place `docs/ux-theme.md` allows a literal — and a test pins
 * them to the compiler so they cannot drift from what the app actually paints.
 */

// --------------------------------------------------------------- the tree ---

/** One element of the scene. `text` is the element's only child when present. */
export interface StartupNode {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly StartupNode[];
  readonly text?: string;
}

export interface StartupSceneOptions {
  /**
   * Prefixes the gradient ids. Two of these screens can be on the page at once
   * (the app renders the exiting copy over the live one), and an SVG gradient
   * is referenced by a document-wide id.
   */
  idPrefix: string;
  /** The product's name, set large under the mark. */
  title: string;
  /** What is being waited for, in words a person reads. */
  label: string;
}

/** The class on the element that fills the window. Both renderers use it. */
export const STARTUP_SCREEN_ROOT_CLASS = "startup-restoration";
/** Added to the copy that is fading out after the app has taken over. */
export const STARTUP_SCREEN_EXIT_CLASS = "startup-restoration-exit";

const BEAM_VIEW_BOX = "0 0 1200 800";

/**
 * The two beams that run in along the horizon, then the four that fall in from
 * the corners. Order is load-bearing: the stagger in `STARTUP_SCREEN_CSS` is
 * addressed by `:nth-child`.
 */
const BEAMS: readonly {
  readonly key: string;
  readonly d: string;
  readonly gradient: { readonly x1: string; readonly y1: string; readonly x2: string; readonly y2: string };
  readonly stops: readonly { readonly offset: string; readonly opacity?: string }[];
}[] = [
  {
    key: "left",
    d: "M0 400C250 400 450 400 590 400",
    gradient: { x1: "0", y1: "400", x2: "590", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.18", opacity: "0.72" }, { offset: "0.72" }, { offset: "1", opacity: "0" }],
  },
  {
    key: "right",
    d: "M1200 400C950 400 750 400 610 400",
    gradient: { x1: "1200", y1: "400", x2: "610", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.18", opacity: "0.72" }, { offset: "0.72" }, { offset: "1", opacity: "0" }],
  },
  {
    key: "top-left",
    d: "M360 0C360 164 402 248 484 300C548 341 578 369 590 400",
    gradient: { x1: "360", y1: "0", x2: "590", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.2", opacity: "0.58" }, { offset: "0.8" }, { offset: "1", opacity: "0" }],
  },
  {
    key: "bottom-left",
    d: "M360 800C360 636 402 552 484 500C548 459 578 431 590 400",
    gradient: { x1: "360", y1: "800", x2: "590", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.2", opacity: "0.58" }, { offset: "0.8" }, { offset: "1", opacity: "0" }],
  },
  {
    key: "top-right",
    d: "M840 0C840 164 798 248 716 300C652 341 622 369 610 400",
    gradient: { x1: "840", y1: "0", x2: "610", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.2", opacity: "0.58" }, { offset: "0.8" }, { offset: "1", opacity: "0" }],
  },
  {
    key: "bottom-right",
    d: "M840 800C840 636 798 552 716 500C652 459 622 431 610 400",
    gradient: { x1: "840", y1: "800", x2: "610", y2: "400" },
    stops: [{ offset: "0", opacity: "0" }, { offset: "0.2", opacity: "0.58" }, { offset: "0.8" }, { offset: "1", opacity: "0" }],
  },
];

/** The approved product mark, from the brand assets. The only copy there is. */
export const PRODUCT_MARK_VIEW_BOX = "307 299 1451 1451";
export const PRODUCT_MARK_PATHS: readonly { readonly fill: string; readonly d: string }[] = [
  {
    fill: "currentColor",
    d: "M1180.79 306.057C1225.56 305.663 1256.36 305.598 1291.95 338.371C1315.37 359.95 1329.19 389.986 1330.35 421.805C1331.54 455.906 1330.8 493.514 1330.77 527.834L1330.74 701.761L1330.82 1217.7L1330.82 1498.43L1330.88 1583.44C1330.89 1635.65 1333.67 1666.04 1295.65 1707.16C1295.14 1707.69 1294.63 1708.21 1294.11 1708.72C1259.1 1743.11 1225.46 1742.17 1180.7 1742.15L1180.79 306.057Z",
  },
  {
    fill: "currentColor",
    d: "M833.995 306.443C844.749 305.949 856.731 306.121 867.58 306.052L867.848 900.005L751.824 899.952L718.22 900.041C717.581 788.894 717.767 677.744 718.779 566.599L718.468 467.507C718.257 420.39 714.978 382.516 749.873 345.152C773.13 320.248 799.966 307.958 833.995 306.443Z",
  },
  {
    fill: "currentColor",
    d: "M718.272 1150.4C764.876 1149.26 820.964 1150.1 867.992 1150.58L867.964 1549.21L867.966 1676.81C867.972 1695.62 869.012 1724.11 867.677 1742.13C860.719 1742.26 853.761 1742.34 846.802 1742.38C809.736 1742.56 779.768 1733.46 752.819 1707.25C714.574 1670.06 718.171 1627.35 718.256 1579.36L718.454 1476.54L718.272 1150.4Z",
  },
  {
    fill: "var(--live)",
    d: "M499.374 946.498L1136.13 946.161L1136.21 1102.65L952.75 1102.77L566.611 1102.68L457.318 1102.75C411.994 1102.77 373.235 1108.36 337.618 1074.73C308.228 1046.97 306.689 1005.51 335.501 976.76C366.41 945.915 399.289 946.895 439.388 946.713L499.374 946.498Z",
  },
  {
    fill: "var(--live)",
    d: "M1370.99 946.371L1555.05 946.608L1610.12 946.538C1627.3 946.521 1651.58 945.178 1667.76 949.988C1729.19 968.251 1757.85 1028.3 1709.11 1077.17C1695.59 1088.75 1679.29 1096.63 1661.82 1100.04C1641.13 1104.05 1585.29 1102.63 1560.71 1102.66L1371 1102.65L1370.99 946.371Z",
  },
];

/** The mark on its own, so every surface that draws it draws the same paths. */
export function productMarkNode(attrs: Readonly<Record<string, string>> = {}): StartupNode {
  return {
    tag: "svg",
    attrs: { viewBox: PRODUCT_MARK_VIEW_BOX, "aria-hidden": "true", ...attrs },
    children: PRODUCT_MARK_PATHS.map((path) => ({ tag: "path", attrs: { fill: path.fill, d: path.d } })),
  };
}

/** Everything inside the window-filling element, in order. */
export function startupScene({ idPrefix, title, label }: StartupSceneOptions): readonly StartupNode[] {
  const gradientId = (key: string): string => `${idPrefix}-${key}`;
  const beamPath = (beam: (typeof BEAMS)[number], live: boolean): StartupNode => ({
    tag: "path",
    attrs: {
      d: beam.d,
      stroke: `url(#${gradientId(beam.key)})`,
      ...(live ? { pathLength: "1" } : {}),
    },
  });

  return [
    {
      tag: "svg",
      attrs: {
        "aria-hidden": "true",
        viewBox: BEAM_VIEW_BOX,
        preserveAspectRatio: "none",
        class: "startup-restoration-beams",
      },
      children: [
        {
          tag: "defs",
          children: BEAMS.map((beam) => ({
            tag: "linearGradient",
            attrs: {
              id: gradientId(beam.key),
              gradientUnits: "userSpaceOnUse",
              x1: beam.gradient.x1,
              y1: beam.gradient.y1,
              x2: beam.gradient.x2,
              y2: beam.gradient.y2,
            },
            children: beam.stops.map((stop) => ({
              tag: "stop",
              attrs: {
                offset: stop.offset,
                "stop-color": "var(--live)",
                ...(stop.opacity === undefined ? {} : { "stop-opacity": stop.opacity }),
              },
            })),
          })),
        },
        { tag: "g", attrs: { class: "startup-beam-tracks" }, children: BEAMS.map((beam) => beamPath(beam, false)) },
        { tag: "g", attrs: { class: "startup-beam-live" }, children: BEAMS.map((beam) => beamPath(beam, true)) },
      ],
    },
    {
      tag: "div",
      attrs: { class: "startup-aperture" },
      children: [
        { tag: "div", attrs: { class: "startup-aperture-halo", "aria-hidden": "true" } },
        productMarkNode({ class: "startup-mark" }),
        { tag: "p", attrs: { class: "startup-title" }, text: title },
        { tag: "p", attrs: { class: "startup-label" }, text: label },
        {
          tag: "span",
          attrs: { class: "startup-signal", "aria-hidden": "true" },
          children: [{ tag: "span" }],
        },
      ],
    },
  ];
}

// ------------------------------------------------------------ the styling ---

/**
 * Every rule the scene needs, in tokens. `packages/ui/src/globals.css` carries
 * a verbatim copy between `@startup-screen-start` and `@startup-screen-end`;
 * `packages/ui/test/startup-screen.test.ts` prints the difference and fails if
 * anyone edits one without the other.
 *
 * The composition itself is settled and this is a transcription of it: the
 * layout that used to be spelled in utility classes on the React elements is
 * spelled here instead, so a document with no stylesheet of its own draws the
 * identical screen.
 */
export const STARTUP_SCREEN_CSS = `.startup-restoration {
  --startup-beam-duration: calc(var(--motion-morph) * 7);
  --startup-signal-duration: calc(var(--motion-morph) * 5);
  --startup-aperture-size: calc(var(--space-unit) * 48);
  --startup-beam-width: 1.25;
  --startup-beam-track-opacity: 0.16;
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-sans);
  animation: startup-arrive var(--motion-morph) var(--motion-ease) both;
}

.startup-restoration::before {
  content: "";
  position: absolute;
  inset: 0;
  background: radial-gradient(circle at center, color-mix(in oklab, var(--live) 7%, transparent), transparent 48%);
}

/* Already on the glass. The document paints this screen before React exists —
 * from the shell HTML, and in the desktop from the shell's own copy — so the
 * first mount is a takeover of something identical, and fading it in would
 * blink. A later mount, mid-session, is a real arrival and keeps the fade. */
.startup-restoration[data-continuing] {
  animation: none;
}

.startup-restoration-exit {
  pointer-events: none;
  animation: startup-depart var(--motion-morph) var(--motion-ease) both;
}

.startup-restoration-beams {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  mask-image: radial-gradient(ellipse at center, black 18%, transparent 78%);
}

.startup-beam-tracks,
.startup-beam-live {
  fill: none;
  stroke-linecap: round;
  stroke-width: var(--startup-beam-width);
}

.startup-beam-tracks {
  opacity: var(--startup-beam-track-opacity);
}

.startup-beam-live path {
  stroke-dasharray: 0.13 0.87;
  filter: drop-shadow(0 0 var(--space-unit) var(--live));
  animation: startup-beam var(--startup-beam-duration) var(--motion-ease) infinite;
}

.startup-beam-live path:nth-child(2) {
  animation-delay: calc(var(--motion-morph) * -2);
}

.startup-beam-live path:nth-child(3) {
  animation-delay: calc(var(--motion-morph) * -4);
}

.startup-beam-live path:nth-child(4) {
  animation-delay: calc(var(--motion-morph) * -1);
}

.startup-beam-live path:nth-child(5) {
  animation-delay: calc(var(--motion-morph) * -5);
}

.startup-beam-live path:nth-child(6) {
  animation-delay: calc(var(--motion-morph) * -3);
}

.startup-aperture {
  position: relative;
  z-index: 10;
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.startup-aperture-halo {
  position: absolute;
  left: 50%;
  top: 0;
  width: var(--startup-aperture-size);
  aspect-ratio: 1;
  transform: translate(-50%, -38%);
  background: radial-gradient(circle, color-mix(in oklab, var(--live) 20%, transparent), transparent 68%);
  filter: blur(calc(var(--space-unit) * 3));
  animation: startup-halo var(--startup-signal-duration) var(--motion-ease) infinite;
}

.startup-mark {
  position: relative;
  z-index: 10;
  display: block;
  width: calc(var(--space-unit) * 20);
  height: calc(var(--space-unit) * 20);
  color: var(--ink);
  filter: drop-shadow(0 0 calc(var(--space-unit) * 3) color-mix(in oklab, var(--live) 28%, transparent));
  animation: startup-mark var(--startup-signal-duration) var(--motion-ease) infinite;
}

.startup-title {
  margin: calc(var(--space-unit) * 7) 0 0;
  font-size: var(--text-xl);
  line-height: var(--text-xl--line-height);
  font-weight: 600;
  letter-spacing: var(--tracking-title);
}

.startup-label {
  margin: calc(var(--space-unit) * 2) 0 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm--line-height);
  color: var(--ink-2);
}

.startup-signal {
  margin: calc(var(--space-unit) * 5) 0 0;
  display: block;
  width: calc(var(--space-unit) * 24);
  height: 1px;
  overflow: hidden;
  background: var(--line);
}

.startup-signal span {
  display: block;
  width: 50%;
  height: 100%;
  background: var(--live);
  animation: startup-signal var(--startup-signal-duration) var(--motion-ease) infinite;
}

@keyframes startup-arrive {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes startup-depart {
  from { opacity: 1; filter: blur(0); }
  to { opacity: 0; filter: blur(calc(var(--space-unit) * 2)); }
}

@keyframes startup-beam {
  from { stroke-dashoffset: 1; }
  to { stroke-dashoffset: 0; }
}

@keyframes startup-halo {
  0%, 100% { opacity: 0.42; transform: translate(-50%, -38%) scale(0.92); }
  50% { opacity: 0.78; transform: translate(-50%, -38%) scale(1.06); }
}

@keyframes startup-mark {
  0%, 100% { opacity: 0.86; transform: scale(0.98); }
  50% { opacity: 1; transform: scale(1); }
}

@keyframes startup-signal {
  from { transform: translateX(-110%); }
  to { transform: translateX(220%); }
}`;

// -------------------------------------------------------------- the values ---

/**
 * Every declaration the scene reads. The app hands the desktop exactly these,
 * taken from the theme the person is actually looking at, so the standalone
 * page is their screen rather than a default that changes colour when the app
 * takes over.
 */
export const STARTUP_SCREEN_TOKEN_NAMES: readonly string[] = [
  "color-scheme",
  "--bg",
  "--ink",
  "--ink-2",
  "--line",
  "--live",
  "--space-unit",
  "--text-sm",
  "--text-sm--line-height",
  "--text-xl",
  "--text-xl--line-height",
  "--tracking-title",
  "--motion-morph",
  "--motion-ease",
  "--font-sans",
];

export type StartupScreenTokens = Readonly<Record<string, string>>;

/**
 * What the scene reads that no theme changes. Pinned to the compiled default
 * preset (and, for `--tracking-title`, to the type scale in `globals.css`) by
 * `packages/ui/test/startup-screen.test.ts`.
 */
export const STARTUP_SCREEN_BASE_TOKENS: StartupScreenTokens = {
  "--space-unit": "4px",
  "--text-sm": "13px",
  "--text-sm--line-height": "18px",
  "--text-xl": "22px",
  "--text-xl--line-height": "28px",
  "--tracking-title": "-0.01em",
  "--motion-morph": "260ms",
  "--motion-ease": "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "--font-sans":
    '"Host Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

/**
 * The two default presets' grounds, for a launch that has never had the app
 * open and so has nothing recorded. The app follows the desktop's light/dark
 * setting until somebody picks a theme, so both halves are needed and the page
 * chooses between them with `prefers-color-scheme` — the same question the
 * app's own boot script asks.
 *
 * These are preset values, not new colours: the test above compiles the two
 * default presets and fails if a single character here disagrees.
 */
export const STARTUP_SCREEN_FALLBACK_GROUND: Readonly<Record<"dark" | "light", StartupScreenTokens>> = {
  dark: {
    "color-scheme": "dark",
    "--bg": "#000000",
    "--ink": "#e9e8e6",
    "--ink-2": "#afb1b4",
    "--line": "#323335",
    "--live": "#03cc7b",
  },
  light: {
    "color-scheme": "light",
    "--bg": "#e9e8e6",
    "--ink": "#000000",
    "--ink-2": "#5c5752",
    "--line": "#cfc9c4",
    "--live": "#007835",
  },
};

// ------------------------------------------------------------- serializing ---

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

/** The scene as HTML, for a document that has no React in it. */
export function renderStartupNodes(nodes: readonly StartupNode[]): string {
  return nodes.map(renderStartupNode).join("");
}

function renderStartupNode(node: StartupNode): string {
  const attrs = Object.entries(node.attrs ?? {})
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  const inner = node.text !== undefined ? escapeHtml(node.text) : renderStartupNodes(node.children ?? []);
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

const declarations = (tokens: StartupScreenTokens): string =>
  Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

export interface StartupScreenPageOptions {
  /** The product's name: the document title and the wordmark. */
  title: string;
  /** What is being waited for, in words a person reads. */
  label: string;
  /**
   * Applied to `:root` unconditionally — the base tokens, plus the person's own
   * ground when they have chosen a theme rather than following the desktop.
   */
  tokens: StartupScreenTokens;
  /**
   * Applied by `prefers-color-scheme`, for the person who follows the desktop's
   * light/dark setting. Left out when they have chosen for themselves.
   */
  pair?: Readonly<Record<"dark" | "light", StartupScreenTokens>> | undefined;
}

/**
 * The whole opening screen as one standalone document: no bundle, no fonts to
 * fetch, no origin, nothing to load. Everything it draws is in the string.
 */
export function startupScreenPageHtml({ title, label, tokens, pair }: StartupScreenPageOptions): string {
  const pairCss = pair
    ? `\n@media (prefers-color-scheme: light) {\n  :root {\n${declarations(pair.light)}\n  }\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n${declarations(pair.dark)}\n  }\n}\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
:root {
${declarations(tokens)}
}
${pairCss}
* { box-sizing: border-box; }

html, body {
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: var(--bg);
}

body {
  color: var(--ink);
  font-family: var(--font-sans);
  /* The frameless window is dragged by its own surface, and this screen is the
   * whole surface. Nothing here is clickable, so nothing opts out. */
  -webkit-app-region: drag;
}

/* The same stillness the app falls back to, so asking for less motion does not
 * change what the opening screen is between here and there. */
@media (prefers-reduced-motion: reduce) {
  *,
  ::before,
  ::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

${STARTUP_SCREEN_CSS}
</style>
</head>
<body>
<div class="${STARTUP_SCREEN_ROOT_CLASS}" role="status" aria-live="polite" aria-busy="true" aria-label="${escapeHtml(label)}">${renderStartupNodes(startupScene({ idPrefix: "startup", title, label }))}</div>
</body>
</html>`;
}
