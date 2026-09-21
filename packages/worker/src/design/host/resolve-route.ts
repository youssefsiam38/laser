/**
 * A route or a file → the files that actually draw that page (M21-T12).
 *
 * `docs/design-phase.md`, "Grounding the host page — static only": the
 * template, its partials, includes and layouts, the owning controller or
 * view-model where the convention makes it findable, and the stylesheets the
 * template or layout names. Nothing here imports a project module, evaluates
 * a config or asks a router: every answer is read off the path conventions
 * and the text of the files themselves, which is the only way the Design
 * phase is allowed to work (D-353).
 *
 * What it knows:
 *
 * | Stack | Entry | Layouts | Partials | Owner |
 * | --- | --- | --- | --- | --- |
 * | `next-app` | `app/**\/page.tsx` | every `layout.*` up to `app/` | local imports | `route.ts`, the page's own server component |
 * | `next-pages` | `pages/**.tsx` | `_app`, `_document` | local imports | — |
 * | `nuxt` | `pages/**.vue` | `layouts/<name>.vue` | imports and `components/` tags | — |
 * | `sveltekit` | `src/routes/**\/+page.svelte` | `+layout.svelte` up the tree | imports | `+page.server.ts`, `+page.ts` |
 * | `remix` | `app/routes/*.tsx` | `app/root.tsx`, parent routes | imports | the route module itself |
 * | `rails` | `app/views/<c>/<a>.html.erb` | `app/views/layouts/*` | `render "…"` | `app/controllers/<c>_controller.rb` |
 * | `blade` | `resources/views/**.blade.php` | `@extends` | `@include`, `<x-…>` | the controller that calls `view('…')` |
 * | `jinja` | `**\/templates/**.html` | `{% extends %}` | `{% include %}` | the `views.py` that renders it |
 * | `html` | `*.html` | — | SSI and comment includes | — |
 *
 * When a name matches nothing the answer says so and lists the candidates it
 * did find; it never guesses a file that is not there.
 */
import type { Gap } from "../index/facts.js";
import { basenameOf, dirnameOf, joinPath, normalisePath, pickExisting, type HostFiles } from "./files.js";

export const HOST_STACKS = ["next-app", "next-pages", "nuxt", "sveltekit", "remix", "rails", "blade", "jinja", "html", "unknown"] as const;
export type HostStack = (typeof HOST_STACKS)[number];

export interface RouteResolution {
  /** What was asked for, as it was asked. */
  routeOrPath: string;
  stack: HostStack;
  /** The route this page is served at, when the convention says one. */
  route?: string;
  /** The template the page's own content lives in. */
  templatePath?: string;
  /** Outermost first: the layouts this template renders inside. */
  layouts: string[];
  /** Partials, includes and components the template or a layout pulls in. */
  partials: string[];
  /** The controller, loader or view-model, when the convention finds one. */
  controllers: string[];
  /** Stylesheets the template or a layout names. */
  stylesheets: string[];
  /** Everything above, deduplicated: layouts, template, partials, owner, styles. */
  files: string[];
  /** Other pages that could have been meant, when nothing matched exactly. */
  candidates: string[];
  gaps: Gap[];
}

const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];
const MODULE_EXTENSIONS = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".vue", ".svelte", ".astro", ...STYLE_EXTENSIONS];
const INDEX_EXTENSIONS = ["/index.tsx", "/index.ts", "/index.jsx", "/index.js", "/index.vue", "/index.svelte"];
const MAX_RELATED = 60;
const MAX_INCLUDE_DEPTH = 3;

const NEXT_APP = /^(?:src\/)?app\/(?:(.+)\/)?page\.(?:tsx|jsx|ts|js|mjs)$/;
const NEXT_PAGES = /^(?:src\/)?pages\/(.+)\.(?:tsx|jsx|ts|js|mjs)$/;
const NUXT_PAGES = /^(?:src\/)?pages\/(.+)\.vue$/;
const SVELTEKIT = /^(?:src\/)?routes\/(?:(.+)\/)?\+page\.svelte$/;
const REMIX = /^app\/routes\/(.+)\.(?:tsx|jsx|ts|js)$/;
const RAILS = /^app\/views\/(.+?)\.(?:html\.erb|erb|html\.haml|haml|html\.slim|slim)$/;
const BLADE = /^resources\/views\/(.+)\.blade\.php$/;
const JINJA = /(?:^|\/)templates\/(.+)\.(?:html|htm|jinja|jinja2|j2|twig)$/;
const PLAIN_HTML = /\.(?:html|htm)$/;

/** Which convention this path belongs to, by its shape alone. */
export function hostStackOf(path: string): HostStack {
  if (NEXT_APP.test(path)) return "next-app";
  if (SVELTEKIT.test(path)) return "sveltekit";
  if (REMIX.test(path)) return "remix";
  if (NUXT_PAGES.test(path)) return "nuxt";
  if (NEXT_PAGES.test(path)) return "next-pages";
  if (RAILS.test(path)) return "rails";
  if (BLADE.test(path)) return "blade";
  if (JINJA.test(path)) return "jinja";
  if (PLAIN_HTML.test(path)) return "html";
  return "unknown";
}

function segments(value: string): string[] {
  return value.split("/").filter((part) => part !== "");
}

/** `[id]` → `:id`, `[...rest]` → `:rest*`, `$id` → `:id`, `(group)` dropped. */
function routeSegment(part: string): string | undefined {
  if (part.startsWith("(") && part.endsWith(")")) return undefined;
  if (part.startsWith("@")) return undefined;
  const spread = /^\[\.\.\.(.+)\]$/.exec(part);
  if (spread) return `:${spread[1] ?? "rest"}*`;
  const dynamic = /^\[(.+)\]$/.exec(part);
  if (dynamic) return `:${dynamic[1] ?? "param"}`;
  if (part.startsWith("$")) return `:${part.slice(1)}`;
  return part;
}

function asRoute(parts: readonly (string | undefined)[]): string {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return `/${kept.join("/")}`.replace(/\/{2,}/g, "/");
}

/** The Rails action → route tail, by the convention Rails itself uses. */
function railsActionTail(action: string): string | undefined {
  if (action === "index") return undefined;
  if (action === "show") return ":id";
  if (action === "edit") return ":id/edit";
  return action;
}

/** The route this template is served at, by convention. Text only. */
export function routeForTemplate(path: string, stack: HostStack = hostStackOf(path)): string | undefined {
  switch (stack) {
    case "next-app": {
      const match = NEXT_APP.exec(path);
      return match ? asRoute(segments(match[1] ?? "").map(routeSegment)) : undefined;
    }
    case "next-pages":
    case "nuxt": {
      const match = (stack === "nuxt" ? NUXT_PAGES : NEXT_PAGES).exec(path);
      const rest = match?.[1];
      if (rest === undefined) return undefined;
      if (basenameOf(rest).startsWith("_")) return undefined;
      const parts = segments(rest.replace(/\/index$/, "")).filter((part) => part !== "index");
      return asRoute(parts.map(routeSegment));
    }
    case "sveltekit": {
      const match = SVELTEKIT.exec(path);
      return match ? asRoute(segments(match[1] ?? "").map(routeSegment)) : undefined;
    }
    case "remix": {
      const match = REMIX.exec(path);
      const rest = match?.[1];
      if (rest === undefined) return undefined;
      const parts = rest
        .split(".")
        .filter((part) => part !== "_index" && part !== "index" && part !== "route")
        .map((part) => (part === "_" ? undefined : routeSegment(part)));
      return asRoute(parts);
    }
    case "rails": {
      const match = RAILS.exec(path);
      const rest = match?.[1];
      if (rest === undefined) return undefined;
      const parts = segments(rest);
      const action = parts.pop() ?? "";
      if (action.startsWith("_") || parts[0] === "layouts") return undefined;
      return asRoute([...parts, railsActionTail(action)]);
    }
    case "blade": {
      const match = BLADE.exec(path);
      const rest = match?.[1];
      if (rest === undefined) return undefined;
      const parts = segments(rest).filter((part) => part !== "index");
      if (["layouts", "partials", "components"].includes(parts[0] ?? "")) return undefined;
      return asRoute(parts);
    }
    case "jinja": {
      const match = JINJA.exec(path);
      const rest = match?.[1];
      if (rest === undefined) return undefined;
      const parts = segments(rest).filter((part) => part !== "index");
      if (["layouts", "partials", "includes"].includes(parts[0] ?? "")) return undefined;
      return asRoute(parts);
    }
    case "html": {
      const parts = segments(path.replace(PLAIN_HTML, "")).filter((part) => part !== "index");
      return asRoute(parts);
    }
    default:
      return undefined;
  }
}

function normaliseRoute(value: string): string {
  const trimmed = value.trim().split(/[?#]/)[0] ?? "";
  const withoutOrigin = trimmed.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const route = `/${segments(withoutOrigin).join("/")}`;
  return route === "/" ? "/" : route.replace(/\/$/, "");
}

/** Every file that looks like a page, with the route it would be served at. */
export function pageCandidates(files: HostFiles): Array<{ path: string; stack: HostStack; route: string }> {
  const pages: Array<{ path: string; stack: HostStack; route: string }> = [];
  for (const path of files.paths) {
    const stack = hostStackOf(path);
    if (stack === "unknown") continue;
    if (isPartialPath(path, stack)) continue;
    const route = routeForTemplate(path, stack);
    if (route === undefined) continue;
    pages.push({ path, stack, route });
  }
  return pages;
}

/** A file that is only ever rendered inside another one. Never a page. */
function isPartialPath(path: string, stack: HostStack): boolean {
  const base = basenameOf(path);
  if (base.startsWith("_") && (stack === "rails" || stack === "jinja")) return true;
  if (stack === "rails" && path.startsWith("app/views/layouts/")) return true;
  if (stack === "blade" && /^resources\/views\/(layouts|partials|components)\//.test(path)) return true;
  if (stack === "jinja" && /(^|\/)templates\/(layouts|partials|includes)\//.test(path)) return true;
  if (stack === "html" && /(^|\/)(partials|includes|_partials)\//.test(path)) return true;
  return false;
}

// ------------------------------------------------------------------ imports

const IMPORT_SPECIFIER = /(?:^|[\n;{])\s*import\s+(?:[^;'"()]*?\sfrom\s+)?["']([^"']+)["']/g;
const EXPORT_FROM = /(?:^|[\n;])\s*export\s+[^;'"]*?\sfrom\s+["']([^"']+)["']/g;

/** Resolve one import specifier against the file set. Aliases by convention. */
function resolveSpecifier(files: HostFiles, from: string, specifier: string): string | undefined {
  if (specifier.startsWith("http:") || specifier.startsWith("https:") || specifier.startsWith("data:")) return undefined;
  const bases: string[] = [];
  if (specifier.startsWith(".")) {
    bases.push(joinPath(dirnameOf(from), specifier));
  } else if (/^[@~$#]/.test(specifier)) {
    const bare = specifier.replace(/^[@~]{1,2}\//, "").replace(/^\$lib\//, "lib/").replace(/^#/, "");
    bases.push(bare, `src/${bare}`, `app/${bare}`, `src/lib/${bare}`);
  } else if (specifier.startsWith("/")) {
    bases.push(normalisePath(specifier));
  } else {
    // A bare specifier is a package: not a file of this project.
    return undefined;
  }
  for (const base of bases) {
    const found = pickExisting(files, [...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`), ...INDEX_EXTENSIONS.map((extension) => `${base}${extension}`)]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isStylesheet(path: string): boolean {
  return STYLE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Follow local imports from a set of modules, bounded in depth and count. */
function followImports(files: HostFiles, roots: readonly string[]): { partials: string[]; stylesheets: string[] } {
  const partials: string[] = [];
  const stylesheets: string[] = [];
  const seen = new Set<string>(roots);
  let frontier = [...roots];
  for (let depth = 0; depth < MAX_INCLUDE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      const text = files.read(path);
      if (text === undefined) continue;
      for (const pattern of [IMPORT_SPECIFIER, EXPORT_FROM]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
          const resolved = resolveSpecifier(files, path, match[1] ?? "");
          if (resolved === undefined || seen.has(resolved)) continue;
          seen.add(resolved);
          if (isStylesheet(resolved)) {
            stylesheets.push(resolved);
            continue;
          }
          if (partials.length + next.length >= MAX_RELATED) continue;
          partials.push(resolved);
          next.push(resolved);
        }
      }
    }
    frontier = next;
  }
  return { partials, stylesheets };
}

/** `<TheSidebar />` in a Vue or Svelte template → `components/TheSidebar.vue`. */
function componentTags(files: HostFiles, path: string, roots: readonly string[]): string[] {
  const text = files.read(path);
  if (text === undefined) return [];
  const found: string[] = [];
  const pattern = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1] ?? "";
    const resolved = pickExisting(
      files,
      roots.flatMap((root) => [`${root}/${name}.vue`, `${root}/${name}/index.vue`, `${root}/${name}.svelte`, `${root}/${name}.tsx`]),
    );
    if (resolved !== undefined && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

// ------------------------------------------------------------- the templates

const RAILS_RENDER = /render\s*(?:\(\s*)?(?:partial:\s*)?["']([\w./-]+)["']/g;
const BLADE_INCLUDE = /@(?:include|includeIf|includeWhen|includeFirst|each|component)\s*\(\s*\[?\s*["']([\w.\-/]+)["']/g;
const BLADE_EXTENDS = /@extends\s*\(\s*["']([\w.\-/]+)["']\s*\)/g;
const BLADE_COMPONENT_TAG = /<x-([a-z0-9][\w.-]*)/gi;
const JINJA_EXTENDS = /\{%-?\s*extends\s+["']([^"']+)["']/g;
const JINJA_INCLUDE = /\{%-?\s*(?:include|import|from)\s+["']([^"']+)["']/g;
const HTML_INCLUDE = /<!--\s*(?:#include\s+(?:file|virtual)\s*=\s*["']([^"']+)["']|(?:@?include:?\s+)([\w./-]+))\s*-->/g;
const HTML_LINK = /<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi;
// The value may itself carry quotes (`href="{% static 'a.css' %}"`), so the
// closing quote is the one that opened it, not the first one seen.
const HTML_HREF = /href\s*=\s*(["'])([\s\S]*?)\1/i;
const RAILS_STYLESHEET = /stylesheet_link_tag\s*\(?\s*["']([\w./-]+)["']/g;
const BLADE_VITE = /@vite\s*\(\s*\[?([^)]*)\)/g;

function matchesOf(text: string, pattern: RegExp, group = 1): string[] {
  pattern.lastIndex = 0;
  const found: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[group] ?? match[2];
    if (value !== undefined && value !== "") found.push(value);
  }
  return found;
}

/** `shared/filters` from `app/views/invoices/index.html.erb` → the partial file. */
function railsPartial(files: HostFiles, from: string, name: string): string | undefined {
  const parts = segments(name);
  const base = parts.pop() ?? "";
  const directory = parts.length > 0 ? `app/views/${parts.join("/")}` : dirnameOf(from);
  return pickExisting(
    files,
    [".html.erb", ".erb", ".html.haml", ".haml", ".html.slim", ".slim"].map((extension) => `${directory}/_${base}${extension}`),
  );
}

function bladeView(files: HostFiles, name: string): string | undefined {
  const path = name.replace(/\./g, "/");
  return pickExisting(files, [`resources/views/${path}.blade.php`, `resources/views/${path}/index.blade.php`]);
}

function jinjaTemplate(files: HostFiles, from: string, name: string): string | undefined {
  const roots = new Set<string>();
  for (const path of files.paths) {
    const match = /(.*?)(?:^|\/)templates\//.exec(path);
    if (match) roots.add(joinPath(match[1] ?? "", "templates"));
  }
  roots.add(dirnameOf(from));
  return pickExisting(files, [...roots].map((root) => joinPath(root, name)));
}

function htmlInclude(files: HostFiles, from: string, name: string): string | undefined {
  return pickExisting(files, [joinPath(dirnameOf(from), name), normalisePath(name)]);
}

/** Stylesheets a markup file names in a `<link rel="stylesheet">`. */
function linkedStylesheets(files: HostFiles, path: string): string[] {
  const text = files.read(path);
  if (text === undefined) return [];
  const found: string[] = [];
  for (const tag of text.match(HTML_LINK) ?? []) {
    const href = HTML_HREF.exec(tag)?.[2];
    if (href === undefined || /^(?:https?:)?\/\//.test(href)) continue;
    // `{% static 'css/site.css' %}`, `{{ asset('css/app.css') }}` — the name
    // inside the tag is what is on disk; the tag itself is never evaluated.
    const cleaned = href
      .replace(/\{%-?\s*(?:static|url)\s+/g, "")
      .replace(/\{\{\s*(?:asset|mix|url)?\s*\(?/g, "")
      .replace(/\)?\s*\}\}/g, "")
      .replace(/-?%\}/g, "")
      .trim()
      .replace(/^['"`]+|['"`]+$/g, "")
      .trim();
    const resolved = pickExisting(files, [
      joinPath(dirnameOf(path), cleaned),
      normalisePath(cleaned),
      joinPath("public", cleaned),
      joinPath("static", cleaned),
      joinPath("resources", cleaned),
      ...files.paths.filter((candidate) => candidate.endsWith(`/${normalisePath(cleaned)}`)).slice(0, 4),
    ]);
    if (resolved !== undefined && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

/** Follow template includes (ERB, Blade, Jinja, HTML) from a set of files. */
function followIncludes(files: HostFiles, stack: HostStack, roots: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set(roots);
  let frontier = [...roots];
  for (let depth = 0; depth < MAX_INCLUDE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      const text = files.read(path);
      if (text === undefined) continue;
      const resolved: Array<string | undefined> = [];
      if (stack === "rails") {
        for (const name of matchesOf(text, RAILS_RENDER)) resolved.push(railsPartial(files, path, name));
      } else if (stack === "blade") {
        for (const name of matchesOf(text, BLADE_INCLUDE)) resolved.push(bladeView(files, name));
        for (const name of matchesOf(text, BLADE_COMPONENT_TAG)) resolved.push(bladeView(files, `components.${name}`));
      } else if (stack === "jinja") {
        for (const name of matchesOf(text, JINJA_INCLUDE)) resolved.push(jinjaTemplate(files, path, name));
      } else {
        for (const name of matchesOf(text, HTML_INCLUDE)) resolved.push(htmlInclude(files, path, name));
      }
      for (const candidate of resolved) {
        if (candidate === undefined || seen.has(candidate) || found.length >= MAX_RELATED) continue;
        seen.add(candidate);
        found.push(candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  return found;
}

// ------------------------------------------------------------------ per stack

function layoutsAbove(files: HostFiles, path: string, root: string, names: readonly string[]): string[] {
  const layouts: string[] = [];
  let directory = dirnameOf(path);
  for (let guard = 0; guard < 12; guard += 1) {
    const found = pickExisting(files, names.map((name) => joinPath(directory, name)));
    if (found !== undefined) layouts.unshift(found);
    if (directory === "" || directory === root || !directory.includes("/")) break;
    directory = dirnameOf(directory);
  }
  return layouts;
}

function railsController(files: HostFiles, templatePath: string): string[] {
  const match = RAILS.exec(templatePath);
  const parts = segments(match?.[1] ?? "");
  parts.pop();
  if (parts.length === 0) return [];
  const found = pickExisting(files, [`app/controllers/${parts.join("/")}_controller.rb`]);
  return found === undefined ? [] : [found];
}

function bladeController(files: HostFiles, viewName: string): string[] {
  const needle = new RegExp(`view\\s*\\(\\s*["']${viewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
  const found: string[] = [];
  for (const path of files.paths) {
    if (!/^app\/Http\/Controllers\/.+\.php$/.test(path)) continue;
    const text = files.read(path);
    if (text !== undefined && needle.test(text)) found.push(path);
    if (found.length >= 4) break;
  }
  return found;
}

function jinjaView(files: HostFiles, templatePath: string): string[] {
  const relative = /(?:^|\/)templates\/(.+)$/.exec(templatePath)?.[1];
  if (relative === undefined) return [];
  const found: string[] = [];
  for (const path of files.paths) {
    if (!/(?:^|\/)(?:views|handlers|routes)\.py$/.test(path)) continue;
    const text = files.read(path);
    if (text !== undefined && text.includes(relative)) found.push(path);
    if (found.length >= 4) break;
  }
  return found;
}

/** The single entry point: a route, a template path, or a view name. */
export function resolveRoute(files: HostFiles, routeOrPath: string): RouteResolution {
  const asked = routeOrPath.trim();
  const gaps: Gap[] = [];
  const pages = pageCandidates(files);
  const direct = pickExisting(files, [asked, normalisePath(asked)]);
  let templatePath = direct;
  if (templatePath === undefined) {
    const wanted = normaliseRoute(asked);
    const byRoute = pages.filter((page) => page.route === wanted);
    const byViewName = asked.includes(".") && !asked.includes("/") ? pages.filter((page) => page.path.endsWith(`${asked.replace(/\./g, "/")}.blade.php`)) : [];
    templatePath = byRoute[0]?.path ?? byViewName[0]?.path;
    if (templatePath === undefined) {
      return {
        routeOrPath: asked,
        stack: "unknown",
        layouts: [],
        partials: [],
        controllers: [],
        stylesheets: [],
        files: [],
        candidates: pages.slice(0, 20).map((page) => `${page.route} (${page.path})`),
        gaps: [
          {
            path: asked,
            reason:
              pages.length === 0
                ? "no page templates were found under this app root, so there is nothing to ground against; name a template file instead of a route."
                : "no template matches this route or path; pick one of the candidates, or name the template file.",
          },
        ],
      };
    }
  }

  const stack = hostStackOf(templatePath);
  const route = routeForTemplate(templatePath, stack);
  const layouts: string[] = [];
  const partials: string[] = [];
  const controllers: string[] = [];
  const stylesheets: string[] = [];

  switch (stack) {
    case "next-app": {
      const root = templatePath.startsWith("src/") ? "src/app" : "app";
      layouts.push(...layoutsAbove(files, templatePath, root, ["layout.tsx", "layout.jsx", "layout.ts", "layout.js"]));
      const template = pickExisting(files, [joinPath(dirnameOf(templatePath), "template.tsx"), joinPath(dirnameOf(templatePath), "template.jsx")]);
      if (template !== undefined) layouts.push(template);
      const followed = followImports(files, [templatePath, ...layouts]);
      partials.push(...followed.partials);
      stylesheets.push(...followed.stylesheets);
      const handler = pickExisting(files, [joinPath(dirnameOf(templatePath), "route.ts"), joinPath(dirnameOf(templatePath), "route.js")]);
      if (handler !== undefined) controllers.push(handler);
      break;
    }
    case "next-pages": {
      const root = templatePath.startsWith("src/") ? "src/pages" : "pages";
      for (const name of ["_app.tsx", "_app.jsx", "_app.js", "_document.tsx", "_document.jsx"]) {
        const found = pickExisting(files, [joinPath(root, name)]);
        if (found !== undefined) layouts.push(found);
      }
      const followed = followImports(files, [templatePath, ...layouts]);
      partials.push(...followed.partials);
      stylesheets.push(...followed.stylesheets);
      break;
    }
    case "nuxt": {
      const text = files.read(templatePath) ?? "";
      const named = /layout:\s*["']([\w-]+)["']/.exec(text)?.[1];
      const layout = pickExisting(files, [`layouts/${named ?? "default"}.vue`, `src/layouts/${named ?? "default"}.vue`, "layouts/default.vue"]);
      if (layout !== undefined) layouts.push(layout);
      const followed = followImports(files, [templatePath, ...layouts]);
      partials.push(...followed.partials);
      stylesheets.push(...followed.stylesheets);
      for (const source of [templatePath, ...layouts]) {
        for (const component of componentTags(files, source, ["components", "src/components", "app/components"])) {
          if (!partials.includes(component)) partials.push(component);
        }
      }
      break;
    }
    case "sveltekit": {
      const root = templatePath.startsWith("src/") ? "src/routes" : "routes";
      layouts.push(...layoutsAbove(files, templatePath, root, ["+layout.svelte"]));
      for (const name of ["+page.server.ts", "+page.ts", "+page.server.js", "+page.js"]) {
        const found = pickExisting(files, [joinPath(dirnameOf(templatePath), name)]);
        if (found !== undefined) controllers.push(found);
      }
      const followed = followImports(files, [templatePath, ...layouts]);
      partials.push(...followed.partials);
      stylesheets.push(...followed.stylesheets);
      for (const source of [templatePath, ...layouts]) {
        for (const component of componentTags(files, source, ["src/lib/components", "src/components", "lib/components"])) {
          if (!partials.includes(component)) partials.push(component);
        }
      }
      break;
    }
    case "remix": {
      const root = pickExisting(files, ["app/root.tsx", "app/root.jsx"]);
      if (root !== undefined) layouts.push(root);
      const name = REMIX.exec(templatePath)?.[1] ?? "";
      const parents = name.split(".").slice(0, -1);
      for (let index = 1; index <= parents.length; index += 1) {
        const parent = pickExisting(files, [`app/routes/${parents.slice(0, index).join(".")}.tsx`, `app/routes/${parents.slice(0, index).join(".")}.jsx`]);
        if (parent !== undefined && parent !== templatePath) layouts.push(parent);
      }
      const followed = followImports(files, [templatePath, ...layouts]);
      partials.push(...followed.partials);
      stylesheets.push(...followed.stylesheets);
      controllers.push(templatePath);
      break;
    }
    case "rails": {
      const controller = railsController(files, templatePath);
      controllers.push(...controller);
      const declared = controller[0] !== undefined ? /^\s*layout\s+["']([\w/-]+)["']/m.exec(files.read(controller[0]) ?? "")?.[1] : undefined;
      const layout = pickExisting(
        files,
        [declared ?? "application", "application"].flatMap((name) => [`app/views/layouts/${name}.html.erb`, `app/views/layouts/${name}.erb`, `app/views/layouts/${name}.html.haml`]),
      );
      if (layout !== undefined) layouts.push(layout);
      partials.push(...followIncludes(files, "rails", [templatePath, ...layouts]));
      for (const source of layouts) {
        for (const name of matchesOf(files.read(source) ?? "", RAILS_STYLESHEET)) {
          const found = pickExisting(files, [".css", ".scss", ".sass"].map((extension) => `app/assets/stylesheets/${name}${extension}`));
          if (found !== undefined && !stylesheets.includes(found)) stylesheets.push(found);
        }
      }
      const controllerName = segments(RAILS.exec(templatePath)?.[1] ?? "").slice(0, -1).join("/");
      for (const name of ["application", controllerName]) {
        if (name === "") continue;
        const found = pickExisting(files, [".css", ".scss", ".sass"].map((extension) => `app/assets/stylesheets/${name}${extension}`));
        if (found !== undefined && !stylesheets.includes(found)) stylesheets.push(found);
      }
      break;
    }
    case "blade": {
      const viewName = (BLADE.exec(templatePath)?.[1] ?? "").split("/").join(".");
      for (const name of matchesOf(files.read(templatePath) ?? "", BLADE_EXTENDS)) {
        const layout = bladeView(files, name);
        if (layout !== undefined) layouts.push(layout);
      }
      partials.push(...followIncludes(files, "blade", [templatePath, ...layouts]));
      controllers.push(...bladeController(files, viewName));
      for (const source of [...layouts, templatePath]) {
        for (const found of linkedStylesheets(files, source)) if (!stylesheets.includes(found)) stylesheets.push(found);
        for (const group of matchesOf(files.read(source) ?? "", BLADE_VITE)) {
          for (const asset of group.split(",")) {
            const cleaned = asset.replace(/["'\]\s]/g, "");
            const found = pickExisting(files, [cleaned]);
            if (found !== undefined && !stylesheets.includes(found)) stylesheets.push(found);
          }
        }
      }
      break;
    }
    case "jinja": {
      for (const name of matchesOf(files.read(templatePath) ?? "", JINJA_EXTENDS)) {
        const layout = jinjaTemplate(files, templatePath, name);
        if (layout !== undefined) layouts.push(layout);
      }
      partials.push(...followIncludes(files, "jinja", [templatePath, ...layouts]));
      controllers.push(...jinjaView(files, templatePath));
      for (const source of [...layouts, templatePath]) {
        for (const found of linkedStylesheets(files, source)) if (!stylesheets.includes(found)) stylesheets.push(found);
      }
      break;
    }
    case "html": {
      partials.push(...followIncludes(files, "html", [templatePath]));
      for (const source of [templatePath, ...partials]) {
        for (const found of linkedStylesheets(files, source)) if (!stylesheets.includes(found)) stylesheets.push(found);
      }
      break;
    }
    default:
      gaps.push({ path: templatePath, reason: "this file is not a page template of a convention this app knows; its outline is read as plain markup." });
      break;
  }

  const ordered = [...layouts, templatePath, ...partials, ...controllers, ...stylesheets];
  const unique = [...new Set(ordered)].filter((path) => path !== "");
  return {
    routeOrPath: asked,
    stack,
    ...(route !== undefined ? { route } : {}),
    templatePath,
    layouts,
    partials,
    controllers,
    stylesheets,
    files: unique.slice(0, 200),
    candidates: [],
    gaps,
  };
}
