/**
 * L0 · every value the project's styling says out loud.
 *
 * Three families, one shape of answer:
 *
 * - **Style sheets** (`.css`, `.scss`, `.sass`, `.less`, `.styl`): custom
 *   properties and `$`/`@` variables are `declared`; literal values inside
 *   declarations are `observed`; `@media (min-width: …)` and `@font-face` are
 *   read as the conventions they are.
 * - **Tailwind config**, read *as text* (D-353): the `theme` / `extend`
 *   object's leaf strings, found by tracking braces, never by importing the
 *   file. A config that computes its values with a function call is a gap, not
 *   a guess.
 * - **CSS-in-JS**: `styled.x`/`css` template literals parsed as declarations,
 *   and plain style/theme object literals parsed as key/value pairs.
 *
 * No file here is imported, transpiled or evaluated, and nothing is resolved
 * through the project's module graph.
 */
import { factId, sourceAt, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";

/** The value families the index groups by. Also the DTCG `$type` mapping. */
export const VALUE_CATEGORIES = [
  "color",
  "spacing",
  "size",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "radius",
  "shadow",
  "duration",
  "easing",
  "zIndex",
  "breakpoint",
  "border",
  "opacity",
] as const;
export type ValueCategory = (typeof VALUE_CATEGORIES)[number];

const COLOR = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|oklch|lab|lch|color)\([^)]*\))$/i;
const LENGTH = /^-?\d*\.?\d+(px|rem|em|%|vh|vw|ch|pt)$/i;
const DURATION = /^-?\d*\.?\d+m?s$/i;
const NUMBER = /^-?\d*\.?\d+$/;

const SPACING_PROPERTIES = /^(margin|padding|gap|row-gap|column-gap|inset|top|right|bottom|left|translate)/;
const SIZE_PROPERTIES = /^(width|height|min-width|max-width|min-height|max-height|flex-basis|size)$/;

/** Which family a `property: value` declaration belongs to, if any. */
export function categorize(property: string, value: string): ValueCategory | undefined {
  const name = property.trim().toLowerCase().replace(/^\$|^--|^@/, "");
  const text = value.trim();
  if (text === "" || text.startsWith("var(") || text.startsWith("$") || text.startsWith("@") || text.includes("{")) return undefined;
  if (COLOR.test(text) || (/color|background|border-color|fill|stroke|shadow-color/.test(name) && /^[a-z]+$/i.test(text) && text.length < 24 && text !== "inherit" && text !== "currentcolor" && text !== "transparent" && text !== "none")) {
    return "color";
  }
  if (name === "font-family" || name.endsWith("font-family") || name.startsWith("font-family")) return "fontFamily";
  if (name === "font-size" || name.includes("font-size")) return "fontSize";
  if (name === "font-weight" || name.includes("font-weight")) return "fontWeight";
  if (name === "line-height") return "lineHeight";
  if (name.includes("radius")) return "radius";
  if (name.includes("box-shadow") || name === "shadow" || name === "text-shadow") return "shadow";
  if (name.includes("duration") || name === "transition-duration" || name === "animation-duration") return "duration";
  if (name.includes("timing-function") || name === "easing") return "easing";
  if (name === "z-index" || name.includes("z-index")) return "zIndex";
  if (name === "opacity") return "opacity";
  if (name === "border" || name === "border-width") return "border";
  if (SPACING_PROPERTIES.test(name) && LENGTH.test(text)) return "spacing";
  if (SIZE_PROPERTIES.test(name) && LENGTH.test(text)) return "size";
  if (DURATION.test(text) && /transition|animation/.test(name)) return "duration";
  return undefined;
}

/**
 * The family a *named* value belongs to when the name is the only clue: a
 * custom property, a Sass variable, a Tailwind theme key.
 */
export function categorizeNamed(name: string, value: string): ValueCategory | undefined {
  const direct = categorize(name, value);
  if (direct) return direct;
  const key = name.toLowerCase();
  const text = value.trim();
  if (/colou?r|brand|primary|secondary|accent|danger|success|warning|info|muted|surface|ink|background|border/.test(key) && (COLOR.test(text) || /^[a-z]+$/i.test(text))) {
    return "color";
  }
  if (/space|spacing|gap|gutter|inset/.test(key) && (LENGTH.test(text) || NUMBER.test(text))) return "spacing";
  if (/radius|rounded/.test(key)) return "radius";
  if (/shadow|elevation/.test(key)) return "shadow";
  if (/duration|speed|motion|transition/.test(key) && DURATION.test(text)) return "duration";
  if (/ease|easing|curve/.test(key)) return "easing";
  if (/screen|breakpoint|media/.test(key) && LENGTH.test(text)) return "breakpoint";
  if (/font-?family|typeface/.test(key)) return "fontFamily";
  if (/font-?size|text/.test(key) && LENGTH.test(text)) return "fontSize";
  if (/font-?weight|weight/.test(key) && NUMBER.test(text)) return "fontWeight";
  if (/z-?index|layer/.test(key) && NUMBER.test(text)) return "zIndex";
  if (LENGTH.test(text)) return "size";
  if (COLOR.test(text)) return "color";
  return undefined;
}

function valueFact(
  file: SourceFile,
  line: number,
  category: ValueCategory,
  name: string,
  value: string,
  confidence: "declared" | "observed",
  detail: Record<string, string> = {},
): DesignFact {
  return {
    id: factId(confidence === "declared" ? "token" : "value", `${category}:${name}:${value}`, file.path, value),
    kind: confidence === "declared" ? "token" : "value",
    name,
    value,
    detail: { category, ...detail },
    source: sourceAt(file, line),
    confidence,
  };
}

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

/**
 * One style sheet. A line scanner, deliberately: a full CSS grammar buys
 * nothing here — the index wants declarations, variables, breakpoints and
 * font families, and a line scanner cannot be tricked into executing
 * anything.
 */
export function parseStyleSheet(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  let selector = "";
  let inComment = false;

  file.lines.forEach((raw, index) => {
    const line = raw.trim();
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      return;
    }
    if (line.startsWith("/*") && !line.includes("*/")) {
      inComment = true;
      return;
    }
    if (line === "" || COMMENT_LINE.test(line)) return;

    const media = /@media[^{]*\(\s*(?:min|max)-width\s*:\s*([^)]+)\)/.exec(line);
    if (media) {
      const width = (media[1] ?? "").trim();
      facts.push(valueFact(file, index, "breakpoint", width, width, "declared", { form: "media query" }));
    }
    if (/@font-face/.test(line)) {
      const family = /font-family\s*:\s*([^;]+);?/.exec(file.lines.slice(index, index + 8).join(" "));
      if (family) {
        const value = (family[1] ?? "").trim().replace(/['"]/g, "");
        facts.push({
          id: factId("font", value, file.path),
          kind: "font",
          name: value,
          value,
          detail: { form: "@font-face" },
          source: sourceAt(file, index),
          confidence: "declared",
        });
      }
    }
    if (/@import\s+url\(/.test(line) && /fonts\.(googleapis|gstatic)/.test(line)) {
      facts.push({
        id: factId("font", `import:${String(index)}`, file.path),
        kind: "font",
        name: "web font import",
        value: line.slice(0, 200),
        detail: { form: "@import" },
        source: sourceAt(file, index),
        confidence: "declared",
      });
    }

    if (line.includes("{") && !line.startsWith("@")) {
      selector = line.slice(0, line.indexOf("{")).trim();
    }

    // A declaration: `property: value;`. Sass/Less variable declarations look
    // the same and are told apart by their sigil.
    const declaration = /^([-@$\w][-\w.]*)\s*:\s*([^;{]+);?$/.exec(line);
    if (!declaration) {
      if (/^\s*[-@$\w][-\w.]*\s*:\s*.*\b(?:calc|clamp|min|max)\(/.test(line)) {
        // Computed values are recorded as what they are: text we did not
        // resolve, so the entry does not claim a value it never had.
        const [, property = "", value = ""] = /^([-@$\w][-\w.]*)\s*:\s*(.+?);?$/.exec(line) ?? [];
        if (property !== "") {
          facts.push({
            id: factId("value", `computed:${property}`, file.path, value),
            kind: "value",
            name: property,
            value: value.trim().slice(0, 200),
            detail: { category: "computed", note: "a computed value, kept as text" },
            source: sourceAt(file, index),
            confidence: "observed",
          });
        }
      }
      return;
    }
    const property = (declaration[1] ?? "").trim();
    const value = (declaration[2] ?? "").trim();
    const declared = property.startsWith("--") || property.startsWith("$") || (property.startsWith("@") && !property.startsWith("@media"));
    const category = declared ? categorizeNamed(property, value) : categorize(property, value);
    if (!category) return;
    facts.push(
      valueFact(file, index, category, declared ? property : property, value, declared ? "declared" : "observed", {
        ...(selector !== "" && !declared ? { selector: selector.slice(0, 120) } : {}),
        ...(declared ? { form: property.startsWith("--") ? "custom property" : "preprocessor variable" } : { property }),
      }),
    );
  });

  return { facts, gaps };
}

// ---------------------------------------------------------------- Tailwind

/** The text span of the first balanced `{…}` after `from`, or undefined. */
function balancedObject(text: string, from: number): { start: number; end: number } | undefined {
  const start = text.indexOf("{", from);
  if (start === -1) return undefined;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: index };
    }
  }
  return undefined;
}

const LEAF = /(["']?)([\w.-]+)\1\s*:\s*(["'`])([^"'`]*)\3/g;

/**
 * A Tailwind config, read as text.
 *
 * Every string leaf under `theme` (and `theme.extend`) becomes a declared
 * token named by its path. A leaf that is a function call, a spread or an
 * identifier is skipped and the file gets a gap saying so — Laser does not run
 * the config to find out what it would have produced.
 */
export function parseTailwindConfig(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const themeAt = file.text.search(/\btheme\s*:/);
  if (themeAt === -1) {
    return { facts, gaps: [{ path: file.path, reason: "this Tailwind config declares no theme, so it contributed no values." }] };
  }
  const span = balancedObject(file.text, themeAt);
  if (!span) {
    return { facts, gaps: [{ path: file.path, reason: "this Tailwind config's theme could not be read as text; nothing was taken from it." }] };
  }
  const body = file.text.slice(span.start, span.end + 1);
  const lineOf = (offset: number): number => file.text.slice(0, span.start + offset).split(/\r?\n/).length - 1;

  // Walk the object's key path by tracking braces, so a leaf knows where it
  // lives (`colors.brand.500`) without a JavaScript parse.
  const path: string[] = [];
  let index = 0;
  let pendingKey: string | undefined;
  while (index < body.length) {
    const character = body[index] ?? "";
    if (character === "{") {
      if (pendingKey !== undefined) path.push(pendingKey);
      pendingKey = undefined;
      index += 1;
      continue;
    }
    if (character === "}") {
      path.pop();
      index += 1;
      continue;
    }
    const rest = body.slice(index);
    const key = /^\s*(["']?)([\w.-]+)\1\s*:\s*/.exec(rest);
    if (key) {
      const name = key[2] ?? "";
      const after = rest.slice(key[0].length);
      const leaf = /^(["'`])([^"'`]*)\1/.exec(after);
      if (leaf) {
        const full = [...path, name].filter((part) => part !== "extend" && part !== "theme").join(".");
        const value = leaf[2] ?? "";
        const category = categorizeNamed(full.replace(/\./g, "-"), value) ?? "size";
        facts.push(
          valueFact(file, lineOf(index), category, full, value, "declared", { form: "tailwind theme" }),
        );
        index += key[0].length + leaf[0].length;
        continue;
      }
      if (/^[A-Za-z_$]/.test(after) || after.startsWith("...")) {
        gaps.push({
          path: file.path,
          reason: `"${[...path, name].join(".")}" is computed in this config. Config is read as text and never run, so its value is not in the index.`,
        });
        index += key[0].length;
        continue;
      }
      pendingKey = name;
      index += key[0].length;
      continue;
    }
    index += 1;
  }
  LEAF.lastIndex = 0;
  return { facts, gaps };
}

// -------------------------------------------------------------- CSS-in-JS

const STYLED_START = /(?:styled\.[A-Za-z][\w$]*|styled\([^)]*\)|css|createGlobalStyle|keyframes)\s*`/g;

/**
 * Styled-components / Emotion template literals and plain style objects.
 *
 * The template's text is scanned as declarations (the same scanner a style
 * sheet gets); an interpolation `${…}` is replaced by a marker so a value that
 * depends on props is never recorded as a literal.
 */
export function parseCssInJs(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const text = file.text;
  STYLED_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STYLED_START.exec(text)) !== null) {
    const open = match.index + match[0].length;
    const close = text.indexOf("`", open);
    if (close === -1) {
      gaps.push({ path: file.path, reason: "a styled template is not closed in this file; the rest of it was not parsed." });
      break;
    }
    const body = text.slice(open, close);
    const startLine = text.slice(0, open).split(/\r?\n/).length - 1;
    const interpolated = body.includes("${");
    const cleaned = body.replace(/\$\{[^}]*\}/g, "INTERPOLATED");
    cleaned.split(/\r?\n/).forEach((raw, offset) => {
      const declaration = /^\s*([-\w]+)\s*:\s*([^;]+);?\s*$/.exec(raw);
      if (!declaration) return;
      const property = declaration[1] ?? "";
      const value = (declaration[2] ?? "").trim();
      if (value.includes("INTERPOLATED")) return;
      const category = categorize(property, value);
      if (!category) return;
      facts.push(valueFact(file, startLine + offset, category, property, value, "observed", { form: "css-in-js", property }));
    });
    if (interpolated) {
      gaps.push({ path: file.path, reason: "some values in this styled template come from props or a theme at runtime; only its literal values are in the index." });
    }
    STYLED_START.lastIndex = close + 1;
  }

  // Theme and style objects: `const theme = { colors: { brand: "#123456" } }`.
  const objectRoot = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g;
  let declaration: RegExpExecArray | null;
  while ((declaration = objectRoot.exec(text)) !== null) {
    const name = declaration[1] ?? "";
    if (!/theme|tokens|colors|palette|styles|typography|spacing|shadows/i.test(name)) continue;
    const span = balancedObject(text, declaration.index + declaration[0].length - 1);
    if (!span) continue;
    const body = text.slice(span.start, span.end + 1);
    const startOffset = span.start;
    const pairs = /(["']?)([\w.-]+)\1\s*:\s*(["'])([^"']*)\3/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairs.exec(body)) !== null) {
      const key = pair[2] ?? "";
      const value = pair[4] ?? "";
      const category = categorizeNamed(key, value);
      if (!category) continue;
      const line = text.slice(0, startOffset + pair.index).split(/\r?\n/).length - 1;
      facts.push(valueFact(file, line, category, `${name}.${key}`, value, "declared", { form: "style object" }));
    }
    objectRoot.lastIndex = span.end;
  }

  return { facts, gaps };
}

/** Whether a path is a Tailwind config, by name. Its contents are read as text. */
export function isTailwindConfig(path: string): boolean {
  return /(^|\/)tailwind\.config\.[cm]?[jt]s$/.test(path);
}

/** Whether a style sheet parser should be pointed at this path. */
export function isStyleSheet(path: string): boolean {
  return /\.(css|scss|sass|less|styl)$/i.test(path);
}
