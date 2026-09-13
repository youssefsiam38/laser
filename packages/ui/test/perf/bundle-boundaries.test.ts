/**
 * What the first conversation is allowed to carry (M16-T31).
 *
 * `docs/perf-bundle.md` records the measurement; this is the guard that keeps
 * it true. It walks the *static* import graph from the app's entry module — the
 * exact graph the bundler turns into the first chunk — and fails when a surface
 * a conversation does not need finds its way back into it.
 *
 * The graph is the evidence, not a list of file names: a helper that quietly
 * imports the map, the inspector or the schema library re-links the heavy
 * module even though the lazy `import()` beside it still exists.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const src = join(root, "src");
const entry = join(src, "main.tsx");

/** `import … from "x"`, `export … from "x"` and `import "x"`, never `import(` or `import type`. */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)(?:\s+([^;]*?)\s+from)?\s*["']([^"']+)["']/g;

/** The file a specifier really names: the same candidates the bundler tries. */
const resolveFile = (file: string): { path: string; source: string } | undefined => {
  for (const candidate of [file, `${file}.ts`, `${file}.tsx`, join(file, "index.ts"), join(file, "index.tsx")]) {
    try {
      return { path: candidate, source: readFileSync(candidate, "utf8") };
    } catch {
      continue;
    }
  }
  return undefined;
};

interface Edge { from: string; specifier: string; names: string[] }

/** Every module and package the entry reaches without going through `import()`. */
function staticGraph(): { modules: Set<string>; packages: Set<string>; edges: Edge[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const edges: Edge[] = [];
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length) {
    const request = queue.pop()!;
    if (seen.has(request)) continue;
    seen.add(request);
    const resolved = resolveFile(request);
    if (!resolved) continue;
    const { path: file, source } = resolved;
    const id = relative(root, file);
    if (modules.has(id)) continue;
    modules.add(id);
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const clause = match[1] ?? "";
      const specifier = match[2] ?? "";
      // `import { type X, y }` — only the value specifiers survive bundling.
      const names = [...clause.matchAll(/[{,]\s*(?!type\s)([A-Za-z_$][\w$]*)/g)].map((name) => name[1] ?? "");
      edges.push({ from: id, specifier, names });
      if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const target = specifier.startsWith("@/")
          ? join(src, specifier.slice(2).replace(/\.js$/, ""))
          : join(dirname(file), specifier.replace(/\.js$/, ""));
        queue.push(target);
      } else if (!specifier.endsWith(".css")) {
        packages.add(specifier.replace(/^((?:@[^/]+\/)?[^/]+).*$/, "$1"));
      }
    }
  }
  return { modules, packages, edges };
}

const graph = staticGraph();
const reaches = (path: string) => [...graph.modules].some((id) => id === `src/${path}` || id.startsWith(`src/${path}`));

describe("the first conversation's chunk", () => {
  it("walks a real graph", () => {
    // A broken walker would pass every other assertion in this file.
    expect(graph.modules.size).toBeGreaterThan(200);
    expect(reaches("components/thread/Thread.tsx")).toBe(true);
    expect(reaches("components/assistant-ui/elements/markdown-text.tsx")).toBe(true);
  });

  it("carries no renderer a conversation may never need", () => {
    for (const pkg of ["katex", "rehype-katex", "@xyflow/react", "beautiful-mermaid", "react-shiki", "handlebars", "zod"]) {
      expect({ package: pkg, importedBy: graph.edges.filter((edge) => edge.specifier.startsWith(pkg)).map((edge) => edge.from) })
        .toEqual({ package: pkg, importedBy: [] });
    }
  });

  it("carries no surface a conversation does not open", () => {
    for (const module of [
      "components/assistant-ui/elements/markdown-katex.ts",
      "components/assistant-ui/elements/mermaid-diagram.tsx",
      "components/assistant-ui/elements/shiki-highlighter-impl.tsx",
      "components/logs/ApiRequestDialogBody.tsx",
      "components/logs/LogsScreen.tsx",
      "components/settings/SettingsScreen.tsx",
      "components/agents/page/AgentsScreen.tsx",
      "components/agents/page/AgentEditor.tsx",
      "components/agents/map/AgentMap.tsx",
      "components/agents/map/MapCanvas.tsx",
      "components/thread/explorer-listing.ts",
    ]) {
      expect({ module, reached: reaches(module) }).toEqual({ module, reached: false });
    }
  });

  /**
   * Two protocol modules are heavy: the instruction-template vocabulary drags
   * a template engine, the wire schemas drag the schema library. The package is
   * one barrel, so a single value import from either anywhere in the static
   * graph puts its dependency back in the first chunk — which is exactly the
   * shape of this defect the last time it happened.
   */
  it("imports no protocol value that drags a parser with it", () => {
    const exported = (file: string): string[] => {
      const source = readFileSync(join(root, "../protocol/src", file), "utf8");
      return [...source.matchAll(/^export\s+(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1] ?? "");
    };
    const heavy = new Set([...exported("instruction-templates.ts"), ...exported("schemas.ts")]);
    expect(heavy.size).toBeGreaterThan(5);
    const offenders = graph.edges
      .filter((edge) => edge.specifier === "@lasercode/protocol")
      .flatMap((edge) => edge.names.filter((name) => heavy.has(name)).map((name) => `${edge.from} imports ${name}`));
    expect(offenders).toEqual([]);
  });
});
