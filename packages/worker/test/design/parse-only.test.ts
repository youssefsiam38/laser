/**
 * The parse-only guarantee (D-353, `docs/design-phase.md` "Security").
 *
 * The Design phase never runs the project: no process, no server, no browser,
 * no network, and no evaluation of a project's own config. That is not a
 * promise in a document here — it is two tests:
 *
 * 1. **The module graph.** Every module reachable from `src/design/index`
 *    and from `src/design/host` (M21-T12: route resolution, outlines,
 *    reference images, insertion regions, strategy) is read, comments
 *    stripped, and checked for the imports and the evaluation primitives
 *    that could break the rule.
 * 2. **A fixture that would tell on us.** `tailwind.config.js` and
 *    `postcss.config.js` in the React fixture write a marker file when they
 *    are executed. The build reads their values and the markers never appear.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildFixture, cleanupFixtures, entryNamed } from "./helpers.js";

afterAll(cleanupFixtures);
afterEach(() => {
  vi.restoreAllMocks();
});

const DESIGN_DIR = resolve(import.meta.dirname, "..", "..", "src", "design", "index");
const HOST_DIR = resolve(import.meta.dirname, "..", "..", "src", "design", "host");

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

describe("the design index and host module graph", () => {
  const graph = new Map([...moduleGraph(DESIGN_DIR), ...moduleGraph(HOST_DIR)]);

  it("covers every module of the index and of host grounding, and the ones they pull in", () => {
    expect(graph.size).toBeGreaterThanOrEqual(21);
    expect([...graph.keys()].some((path) => path.endsWith("command.ts"))).toBe(true);
    for (const name of ["resolve-route.ts", "outline.ts", "reference-image.ts", "insertion-region.ts", "strategy.ts", "ground.ts"]) {
      expect([...graph.keys()].some((path) => path.endsWith(join("host", name))), name).toBe(true);
    }
  });

  it("never decodes a reference image: a screenshot is bytes, not text", () => {
    const offenders: string[] = [];
    for (const [path, text] of graph) {
      if (!path.includes(`${sep}host${sep}`)) continue;
      const source = code(text);
      // No image decoder, no OCR, and nothing that turns image bytes into
      // model-visible text (docs/design-phase.md, "Security").
      for (const forbidden of ["tesseract", "sharp", "jimp", "canvas", "pdfjs", "ocr"]) {
        if (new RegExp(`from\\s+["'][^"']*${forbidden}`, "i").test(source)) offenders.push(`${path}: ${forbidden}`);
      }
      if (/toString\(\s*["']utf-?8["']\s*\)/i.test(source) && /bytes/i.test(source)) offenders.push(`${path}: image bytes read as text`);
    }
    expect(offenders).toEqual([]);
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
