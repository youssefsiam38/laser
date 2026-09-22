/**
 * L0 · the stack, from manifests, lockfiles and the *names* of config files.
 *
 * A manifest is data and is parsed as data (`JSON.parse`, or a line scan for
 * a Gemfile). A config file — `tailwind.config.js`, `postcss.config.cjs`,
 * `vite.config.ts` — is **never** imported, required, transpiled or evaluated
 * (D-353): its presence is the fact, and `l0-styles.ts` reads its text.
 *
 * Everything here is `declared`: the project says it about itself.
 */
import { excerpt, factId, sourceAt, type DesignFact, type Gap, type L0Result, type SourceFile } from "./facts.js";

/** What the stack facts add up to, in the protocol's own shape. */
export interface StackSummary {
  frameworks: string[];
  styling: string[];
  buildTool?: string;
  packageManager?: string;
}

/** A dependency name → the framework it means. First match wins, longest first. */
const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@angular/core", "Angular"],
  ["@remix-run/react", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
  ["react-dom", "React"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["lit", "Lit"],
  ["@stencil/core", "Stencil"],
  ["alpinejs", "Alpine"],
  ["jquery", "jQuery"],
  ["htmx.org", "htmx"],
];

const STYLING: ReadonlyArray<readonly [string, string]> = [
  ["tailwindcss", "Tailwind"],
  ["bootstrap", "Bootstrap"],
  ["bulma", "Bulma"],
  ["sass", "Sass"],
  ["node-sass", "Sass"],
  ["less", "Less"],
  ["stylus", "Stylus"],
  ["styled-components", "styled-components"],
  ["@emotion/react", "Emotion"],
  ["@emotion/styled", "Emotion"],
  ["@stitches/react", "Stitches"],
  ["@vanilla-extract/css", "vanilla-extract"],
  ["@mui/material", "MUI"],
  ["@chakra-ui/react", "Chakra UI"],
  ["antd", "Ant Design"],
  ["@mantine/core", "Mantine"],
  ["@radix-ui/themes", "Radix Themes"],
  ["postcss", "PostCSS"],
  ["@shopify/polaris", "Polaris"],
];

const BUILD_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["vite", "Vite"],
  ["webpack", "webpack"],
  ["rollup", "Rollup"],
  ["parcel", "Parcel"],
  ["esbuild", "esbuild"],
  ["@rspack/core", "Rspack"],
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["gulp", "Gulp"],
];

const DOC_TOOLS: ReadonlyArray<readonly [string, string]> = [
  ["@storybook/react", "Storybook"],
  ["@storybook/vue3", "Storybook"],
  ["storybook", "Storybook"],
  ["@ladle/react", "Ladle"],
  ["react-cosmos", "Cosmos"],
  ["@testing-library/react", "Testing Library"],
];

const ICON_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ["lucide-react", "Lucide"],
  ["lucide-vue-next", "Lucide"],
  ["@heroicons/react", "Heroicons"],
  ["react-icons", "React Icons"],
  ["@fortawesome/fontawesome-svg-core", "Font Awesome"],
  ["bootstrap-icons", "Bootstrap Icons"],
  ["@radix-ui/react-icons", "Radix Icons"],
  ["@phosphor-icons/react", "Phosphor"],
  ["feather-icons", "Feather"],
];

const LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "Yarn"],
  ["bun.lockb", "Bun"],
  ["bun.lock", "Bun"],
  ["Gemfile.lock", "Bundler"],
  ["composer.lock", "Composer"],
];

/**
 * Config files recognised by name. The value is what their presence says; the
 * file is opened only by the parsers that read config *as text*.
 */
const CONFIG_FILES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/(^|\/)tailwind\.config\.[cm]?[jt]s$/, "Tailwind", "styling"],
  [/(^|\/)postcss\.config\.[cm]?[jt]s$/, "PostCSS", "styling"],
  [/(^|\/)vite\.config\.[cm]?[jt]s$/, "Vite", "buildTool"],
  [/(^|\/)webpack\.config\.[cm]?[jt]s$/, "webpack", "buildTool"],
  [/(^|\/)rollup\.config\.[cm]?[jt]s$/, "Rollup", "buildTool"],
  [/(^|\/)next\.config\.[cm]?[jt]s$/, "Next.js", "framework"],
  [/(^|\/)nuxt\.config\.[cm]?[jt]s$/, "Nuxt", "framework"],
  [/(^|\/)svelte\.config\.[cm]?[jt]s$/, "Svelte", "framework"],
  [/(^|\/)angular\.json$/, "Angular", "framework"],
  [/(^|\/)\.storybook\/main\.[cm]?[jt]s$/, "Storybook", "docs"],
  [/(^|\/)\.ladle\/config\.[cm]?[jt]s$/, "Ladle", "docs"],
  [/(^|\/)cosmos\.config\.json$/, "Cosmos", "docs"],
];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One package.json, parsed as the data it is. */
function parsePackageJson(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const gaps: Gap[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch (error) {
    return { facts, gaps: [{ path: file.path, reason: `this manifest is not valid JSON (${error instanceof Error ? error.message : "unreadable"}), so nothing was taken from it.` }] };
  }
  if (!isRecord(parsed)) return { facts, gaps: [{ path: file.path, reason: "this manifest does not hold an object." }] };

  const dependencies: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const group = parsed[field];
    if (!isRecord(group)) continue;
    for (const [name, version] of Object.entries(group)) {
      if (typeof version === "string" && dependencies[name] === undefined) dependencies[name] = version;
    }
  }

  const line = (needle: string): number => {
    const found = file.lines.findIndex((text) => text.includes(`"${needle}"`));
    return found === -1 ? 0 : found;
  };

  const add = (kind: string, name: string, label: string, version?: string): void => {
    facts.push({
      id: factId("stack", `${kind}:${label}`, file.path),
      kind: "stack",
      name: label,
      value: version ?? "",
      detail: { role: kind, package: name },
      source: sourceAt(file, line(name)),
      confidence: "declared",
    });
  };

  for (const [name, label] of FRAMEWORKS) if (dependencies[name] !== undefined) add("framework", name, label, dependencies[name]);
  for (const [name, label] of STYLING) if (dependencies[name] !== undefined) add("styling", name, label, dependencies[name]);
  for (const [name, label] of BUILD_TOOLS) if (dependencies[name] !== undefined) add("buildTool", name, label, dependencies[name]);
  for (const [name, label] of DOC_TOOLS) if (dependencies[name] !== undefined) add("docs", name, label, dependencies[name]);
  for (const [name, label] of ICON_PACKAGES) {
    if (dependencies[name] === undefined) continue;
    facts.push({
      id: factId("icon", label, file.path),
      kind: "icon",
      name: label,
      value: dependencies[name],
      detail: { package: name, form: "package" },
      source: sourceAt(file, line(name)),
      confidence: "declared",
    });
  }

  const manager = parsed["packageManager"];
  if (typeof manager === "string") {
    add("packageManager", "packageManager", manager.split("@")[0] ?? manager, manager);
  }
  const workspaces = parsed["workspaces"];
  if (Array.isArray(workspaces)) {
    facts.push({
      id: factId("stack", "workspaces", file.path),
      kind: "stack",
      name: "workspaces",
      value: workspaces.filter((entry): entry is string => typeof entry === "string").join(", ").slice(0, 400),
      detail: { role: "layout" },
      source: sourceAt(file, line("workspaces")),
      confidence: "declared",
    });
  }
  return { facts, gaps };
}

/** A Gemfile or composer.json: enough to know a template stack when we see one. */
function parseRubyOrPhpManifest(file: SourceFile): L0Result {
  const facts: DesignFact[] = [];
  const push = (label: string, role: string, line: number, value: string): void => {
    facts.push({
      id: factId("stack", `${role}:${label}`, file.path),
      kind: "stack",
      name: label,
      value,
      detail: { role },
      source: sourceAt(file, line),
      confidence: "declared",
    });
  };
  if (file.path.endsWith("Gemfile")) {
    file.lines.forEach((text, index) => {
      const gem = /^\s*gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/.exec(text);
      if (!gem) return;
      const name = gem[1] ?? "";
      const version = gem[2] ?? "";
      if (name === "rails") push("Rails", "framework", index, version);
      if (name === "bootstrap") push("Bootstrap", "styling", index, version);
      if (name === "sassc-rails" || name === "dartsass-rails") push("Sass", "styling", index, version);
      if (name === "tailwindcss-rails") push("Tailwind", "styling", index, version);
      if (name === "view_component") push("ViewComponent", "framework", index, version);
    });
    return { facts, gaps: [] };
  }
  try {
    const parsed: unknown = JSON.parse(file.text);
    const require_ = isRecord(parsed) ? parsed["require"] : undefined;
    if (isRecord(require_)) {
      for (const [name, version] of Object.entries(require_)) {
        const at = file.lines.findIndex((text) => text.includes(`"${name}"`));
        if (name.startsWith("laravel/")) push("Laravel", "framework", at === -1 ? 0 : at, typeof version === "string" ? version : "");
        if (name === "symfony/framework-bundle") push("Symfony", "framework", at === -1 ? 0 : at, typeof version === "string" ? version : "");
      }
    }
    return { facts, gaps: [] };
  } catch {
    return { facts, gaps: [{ path: file.path, reason: "this manifest is not valid JSON, so nothing was taken from it." }] };
  }
}

/** Every stack fact of one file, or nothing when the file is not a manifest. */
export function parseStackFile(file: SourceFile): L0Result {
  const name = file.path.split("/").pop() ?? file.path;
  if (name === "package.json") return parsePackageJson(file);
  if (name === "Gemfile" || name === "composer.json") return parseRubyOrPhpManifest(file);
  return { facts: [], gaps: [] };
}

/**
 * The facts that come from a *path* rather than from a file's contents:
 * lockfiles and config files, recognised by name and never opened.
 */
export function stackFactsFromPaths(paths: readonly string[]): DesignFact[] {
  const facts: DesignFact[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const name = path.split("/").pop() ?? path;
    for (const [lockfile, manager] of LOCKFILES) {
      if (name !== lockfile) continue;
      const key = `packageManager:${manager}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        id: factId("stack", key, path),
        kind: "stack",
        name: manager,
        value: lockfile,
        detail: { role: "packageManager", evidence: "lockfile" },
        source: { path, digest: "", startLine: 1, endLine: 1, excerpt: excerpt(lockfile) },
        confidence: "declared",
      });
    }
    for (const [pattern, label, role] of CONFIG_FILES) {
      if (!pattern.test(path)) continue;
      const key = `${role}:${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        id: factId("stack", key, path),
        kind: "stack",
        name: label,
        value: name,
        // The file's presence is the fact. It is read as text elsewhere and
        // evaluated nowhere (D-353).
        detail: { role, evidence: "config file, by name" },
        source: { path, digest: "", startLine: 1, endLine: 1, excerpt: excerpt(name) },
        confidence: "declared",
      });
    }
  }
  return facts;
}

/** Fold the stack facts into the summary the index carries. */
export function stackSummary(facts: readonly DesignFact[]): StackSummary {
  const frameworks: string[] = [];
  const styling: string[] = [];
  let buildTool: string | undefined;
  let packageManager: string | undefined;
  for (const fact of facts) {
    if (fact.kind !== "stack") continue;
    const role = fact.detail?.["role"];
    if (role === "framework" && !frameworks.includes(fact.name)) frameworks.push(fact.name);
    if (role === "styling" && !styling.includes(fact.name)) styling.push(fact.name);
    if (role === "docs" && !styling.includes(fact.name)) styling.push(fact.name);
    if (role === "buildTool" && buildTool === undefined) buildTool = fact.name;
    if (role === "packageManager" && packageManager === undefined) packageManager = fact.name;
  }
  return {
    frameworks,
    styling,
    ...(buildTool !== undefined ? { buildTool } : {}),
    ...(packageManager !== undefined ? { packageManager } : {}),
  };
}
