/**
 * L0 · routes, pages and templates.
 *
 * The template family is where a project's page conventions actually live:
 * the layout it repeats, the form markup it uses, the empty and error states
 * it writes by hand, and — for an older stack — the class vocabulary that
 * tells one era from another.
 *
 * ERB, Blade, Twig, Handlebars, Liquid, plain HTML and the file-system routes
 * of Next/Nuxt/SvelteKit/Remix are all read as text. A template's expressions
 * (`<%= %>`, `{{ }}`, `@if`) are noted as dynamic regions, never evaluated.
 */
import { excerpt, factId, sourceAt, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";

const TEMPLATE_EXTENSIONS = /\.(erb|haml|slim|twig|hbs|handlebars|ejs|liquid|html|htm|php|astro)$/i;
const ROUTE_DIRECTORIES = /(^|\/)(pages|app|routes|views|templates)\//i;

/** Whether this path is a template or a route file worth outlining. */
export function isTemplatePath(path: string): boolean {
  if (TEMPLATE_EXTENSIONS.test(path)) return true;
  if (!ROUTE_DIRECTORIES.test(path)) return false;
  return /\.(tsx|jsx|vue|svelte)$/.test(path);
}

/** Structural roles an outline records. Text, never markup. */
const REGION_TAGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<header[\s>]/i, "header"],
  [/<nav[\s>]/i, "navigation"],
  [/<main[\s>]/i, "main"],
  [/<aside[\s>]/i, "aside"],
  [/<footer[\s>]/i, "footer"],
  [/<form[\s>]/i, "form"],
  [/<table[\s>]/i, "table"],
  [/<(ul|ol)[\s>]/i, "list"],
  [/<h1[\s>]/i, "heading"],
  [/<h2[\s>]/i, "heading"],
  [/<dialog[\s>]|role=["']dialog["']/i, "dialog"],
  [/<button[\s>]/i, "button"],
];

const STATE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(no results|nothing here|empty|no items|none yet)\b/i, "empty state"],
  [/\b(loading|spinner|skeleton|please wait)\b/i, "loading state"],
  [/\b(error|went wrong|failed|try again)\b/i, "error state"],
  [/\b(success|saved|done|thanks)\b/i, "confirmation"],
];

/**
 * The route a file-system router — or a server-rendered view directory —
 * would serve this file at. Text only: no router is loaded and no config is
 * read to find out what the project really does with it.
 */
export function routeOf(path: string): string | undefined {
  const match = /(^|\/)(app\/views|resources\/views|src\/routes|pages|app|routes|views|templates)\/(.+)$/i.exec(path);
  if (!match) return undefined;
  const rest = (match[3] ?? "")
    .replace(/\.(blade\.php|html\.erb|html\.haml|html\.slim)$/i, "")
    .replace(/\.(tsx|jsx|ts|js|vue|svelte|astro|erb|haml|slim|twig|hbs|handlebars|ejs|liquid|html|htm|php)$/i, "")
    .replace(/\/(page|index|show|\+page)$/i, "")
    .replace(/^(page|index)$/i, "")
    .replace(/\[\.\.\.(\w+)\]/g, ":$1*")
    .replace(/\[(\w+)\]/g, ":$1");
  return `/${rest}`.replace(/\/+/g, "/");
}

/** Class names used in a template, as the era signal they are. */
function classVocabulary(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const pattern = /class(?:Name)?\s*=\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    for (const name of (match[1] ?? "").split(/\s+/)) {
      if (name === "" || name.includes("{")) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/** One template: its outline, its class vocabulary and the states it writes. */
export function parseTemplate(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  const route = routeOf(file.path);
  const regions: string[] = [];
  file.lines.forEach((line, index) => {
    for (const [pattern, role] of REGION_TAGS) {
      if (!pattern.test(line)) continue;
      regions.push(role);
      facts.push({
        id: factId("template", `${file.path}:${role}:${String(index)}`, file.path),
        kind: "template",
        name: role,
        value: excerpt(line),
        detail: { form: "region", ...(route !== undefined ? { route } : {}) },
        source: sourceAt(file, index),
        confidence: "observed",
      });
      break;
    }
    for (const [pattern, kind] of STATE_WORDS) {
      if (!pattern.test(line)) continue;
      facts.push({
        id: factId("template", `${file.path}:${kind}:${String(index)}`, file.path),
        kind: "template",
        name: kind,
        value: excerpt(line),
        detail: { form: "state", ...(route !== undefined ? { route } : {}) },
        source: sourceAt(file, index),
        confidence: "observed",
      });
      break;
    }
  });

  if (route !== undefined) {
    facts.push({
      id: factId("template", `route:${route}`, file.path),
      kind: "template",
      name: route,
      value: regions.join(", ").slice(0, 400),
      detail: { form: "route", regions: String(regions.length) },
      source: sourceAt(file, 0),
      confidence: "declared",
    });
  }

  const classes = classVocabulary(file.text);
  for (const [name, count] of [...classes].sort((left, right) => right[1] - left[1]).slice(0, 60)) {
    facts.push({
      id: factId("class-vocabulary", name, file.path),
      kind: "class-vocabulary",
      name,
      value: String(count),
      detail: { form: "class", ...(route !== undefined ? { route } : {}) },
      source: sourceAt(file, Math.max(0, file.lines.findIndex((line) => line.includes(name)))),
      confidence: "observed",
    });
  }

  const dynamic = (file.text.match(/<%|\{\{|@if|@foreach|\{%/g) ?? []).length;
  if (dynamic > 0 && facts.length === 0) {
    gaps.push({ path: file.path, reason: "this template is mostly dynamic; its structure is decided when the app runs, which the Design phase never does." });
  }
  return { facts, gaps };
}
