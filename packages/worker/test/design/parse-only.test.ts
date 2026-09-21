/**
 * The parse-only guarantee (D-353, `docs/design-phase.md` "Security").
 *
 * The Design phase never runs the project: no process, no server, no browser,
 * no network, and no evaluation of a project's own config. That is not a
 * promise in a document here — it is two tests:
 *
 * 1. **The module graph.** Every module reachable from `src/design/index`
 *    is read, comments stripped, and checked for the imports and the
 *    evaluation primitives that could break the rule.
 * 2. **A fixture that would tell on us.** `tailwind.config.js` and
 *    `postcss.config.js` in the React fixture write a marker file when they
 *    are executed. The build reads their values and the markers never appear.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildFixture, cleanupFixtures, entryNamed } from "./helpers.js";

afterAll(cleanupFixtures);
afterEach(() => {
  vi.restoreAllMocks();
});

const DESIGN_DIR = resolve(import.meta.dirname, "..", "..", "src", "design", "index");

/** Comments out, so a sentence about `require(` is not read as a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every module reachable from a directory, following relative imports only. */
function moduleGraph(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = readdirSync(directory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(directory, name));
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || files.has(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    files.set(path, text);
    const imports = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = imports.exec(code(text))) !== null) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) continue;
      queue.push(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return files;
}

describe("the design index module graph", () => {
  const graph = moduleGraph(DESIGN_DIR);

  it("covers every module of the index, and the ones they pull in", () => {
    expect(graph.size).toBeGreaterThanOrEqual(15);
    expect([...graph.keys()].some((path) => path.endsWith("command.ts"))).toBe(true);
  });

  it("imports nothing that could start a process or leave the machine", () => {
    const forbidden = [
      "node:child_process",
      "child_process",
      "node:net",
      "node:http",
      "node:https",
      "node:dgram",
      "node:tls",
      "node:worker_threads",
      "node:vm",
      "node:cluster",
      "undici",
      "node-fetch",
      "got",
      "axios",
      "playwright",
      "puppeteer",
    ];
    const offenders: string[] = [];
    for (const [path, text] of graph) {
      const source = code(text);
      const imports = /from\s+["']([^"']+)["']/g;
      let match: RegExpExecArray | null;
      while ((match = imports.exec(source)) !== null) {
        const specifier = match[1] ?? "";
        if (forbidden.includes(specifier)) offenders.push(`${path}: ${specifier}`);
      }
      if (/\bfetch\s*\(/.test(source)) offenders.push(`${path}: fetch(`);
      if (/\bXMLHttpRequest\b/.test(source)) offenders.push(`${path}: XMLHttpRequest`);
    }
    expect(offenders).toEqual([]);
  });

  it("evaluates nothing: no eval, no Function, no require, no dynamic import", () => {
    const offenders: string[] = [];
    for (const [path, text] of graph) {
      const source = code(text);
      if (/\beval\s*\(/.test(source)) offenders.push(`${path}: eval(`);
      if (/new\s+Function\s*\(/.test(source)) offenders.push(`${path}: new Function(`);
      if (/\brequire\s*\(/.test(source)) offenders.push(`${path}: require(`);
      if (/\bcreateRequire\s*\(/.test(source)) offenders.push(`${path}: createRequire(`);
      // A dynamic `import(...)` could load a project file; a static one cannot.
      if (/[^.\w]import\s*\(/.test(source)) offenders.push(`${path}: import(`);
      if (/\bjiti\b/.test(source)) offenders.push(`${path}: jiti`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("a project whose config has side effects", () => {
  it("reads the config's values and never executes it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { index, projectCwd } = await buildFixture("react-tailwind");

    // The values are in the index…
    expect(entryNamed(index, "token", "colors.brand.500")?.detail?.["value"]).toBe("#3b82f6");
    expect(entryNamed(index, "token", "screens.lg")?.detail?.["value"]).toBe("1024px");
    // …and the markers the configs would have written are not on disk.
    expect(existsSync(join(projectCwd, "EVALUATED-tailwind"))).toBe(false);
    expect(existsSync(join(projectCwd, "EVALUATED-postcss"))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records the value it could not read without running the config", async () => {
    const { index } = await buildFixture("react-tailwind");
    const gap = index.gaps.find((entry) => entry.path === "tailwind.config.js");
    expect(gap?.reason).toContain("read as text and never run");
    expect(index.entries.some((entry) => entry.detail?.["value"] === "#eef2ff")).toBe(false);
  });
});
