/**
 * Reduced motion removes the animation, it does not make it instant.
 *
 * A zero-duration animation is the worst of both worlds: computed
 * `animation-name` still reads `exit`, so Radix `Presence` keeps the closing
 * element mounted and waits for an `animationend` — while the engine creates
 * no animation at all for it, so nothing ever fires. Measured in Chromium on
 * a bare page with one `@keyframes exit`: `0s` → `getAnimations()` is `[]`
 * and no event, ever; `0.01ms` and `75ms` → one running animation, start and
 * end. The closed dialog stayed on screen, clickable, over the transcript.
 *
 * So the state-driven animations indirect through `--motion-off`: `none` when
 * Motion is reduced (`theme/compile.ts`, and the `prefers-reduced-motion`
 * block for the frame before the theme store runs), the guaranteed-invalid
 * `initial` otherwise so `var()` falls back to the real animation. Verified
 * in Chromium: with `--motion-off: none` the computed name is `none` and
 * `Presence` unmounts at once; with `initial` the name is `exit`, the
 * animation runs and its end arrives.
 *
 * This compiles the real stylesheet with the real Tailwind, so a new surface
 * that animates on `data-state` without the switch fails here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { beforeAll, describe, expect, it } from "vitest";

import { compileVars } from "../../src/theme/compile.js";
import { DEFAULT_PRESET } from "../../src/theme/presets.js";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
const modules = fileURLToPath(new URL("../../node_modules/", import.meta.url));
const globals = join(src, "globals.css");

/** `@import "tw-animate-css"` and friends, resolved through their style export. */
function loadStylesheet(id: string, basedir: string) {
  if (id.startsWith(".")) {
    const path = resolvePath(basedir, id);
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  }
  const manifest = join(modules, id, "package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
    exports?: { "."?: { style?: string } };
    style?: string;
  };
  const path = join(dirname(manifest), pkg.exports?.["."]?.style ?? pkg.style ?? "index.css");
  return { path, base: dirname(path), content: readFileSync(path, "utf8") };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every `animate-*` class the app spells, with its state variant if it has one. */
function animationCandidates(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:data-\[state=[a-z-]+\]:)?(?:motion-safe:|motion-reduce:)?animate-[a-z0-9-]+/g)) {
      found.add(match[0]);
    }
  }
  return [...found];
}

/** The declaration blocks Tailwind emitted, as `[selector, body]`. */
function rules(css: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trimEnd().endsWith("{")) continue;
    const selector = line.trim().slice(0, -1).trim();
    let body = "";
    for (let j = i + 1; j < lines.length && !lines[j]!.trim().startsWith("}"); j += 1) body += `${lines[j]!.trim()}\n`;
    out.push([selector, body]);
  }
  return out;
}

let css = "";
let candidates: string[] = [];

beforeAll(async () => {
  candidates = animationCandidates();
  const compiler = await compile(readFileSync(globals, "utf8"), {
    base: src,
    loadStylesheet: async (id: string, basedir: string) => loadStylesheet(id, basedir),
    loadModule: async () => {
      throw new Error("globals.css loads no JS plugin");
    },
  });
  css = compiler.build(candidates);
}, 30_000);

describe("--motion-off, the switch the whole app's enter/exit animations hang on", () => {
  it("is `none` with Motion reduced and `initial` otherwise", () => {
    expect(compileVars({ ...DEFAULT_PRESET, motion: "reduced" })["--motion-off"]).toBe("none");
    expect(compileVars({ ...DEFAULT_PRESET, motion: "full" })["--motion-off"]).toBe("initial");
  });

  it("is set by the OS preference too, for the frame before the theme store runs", () => {
    const text = readFileSync(globals, "utf8");
    const block = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([\s\S]*?)\}/.exec(text);
    expect(block, "the prefers-reduced-motion block").not.toBeNull();
    expect(block![1]).toContain("--motion-off: none;");
  });

  it("gates every animation the app drives from a `data-state`", () => {
    const stateful = rules(css).filter(([selector, body]) => /\[data-state/.test(selector) && /^\s*animation:/m.test(body));
    expect(stateful.length, "state-driven animation rules compiled").toBeGreaterThan(0);
    for (const [selector, body] of stateful) {
      const declaration = /animation:\s*([^;]+);/.exec(body)?.[1] ?? "";
      expect(declaration.startsWith("var(--motion-off,"), `${selector} → animation: ${declaration}`).toBe(true);
    }
  });

  it("gates the enter/exit utilities themselves, however they are applied", () => {
    for (const utility of ["animate-in", "animate-out"]) {
      expect(candidates, `${utility} is spelled somewhere in src`).toContain(utility);
      const rule = rules(css).find(([selector]) => selector === `.${utility}`);
      expect(rule, `.${utility} compiled`).toBeDefined();
      expect(rule![1]).toContain("animation: var(--motion-off,");
    }
  });

  it("keeps the real animation when motion is on", () => {
    const [, body] = rules(css).find(([selector]) => selector === ".animate-out")!;
    // The fallback — what `initial` resolves to — is the full exit shorthand,
    // duration and easing and all. Reduced motion loses the movement, not the
    // element's departure.
    expect(body).toContain("exit var(--tw-animation-duration");
    expect(body).toContain("var(--tw-duration");
  });
});
