import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contrastRatio, hueDistance, hueOf, oklch, parseColor, raiseContrast } from "../src/theme/color.js";
import { CONTRAST_TARGET, GROUND_TOKENS, TEXT_TOKENS, compileTheme, compileVars, resolveTokens, scaledType } from "../src/theme/compile.js";
import { checkTheme, isApplicable, separateAttention, MIN_HUE_SEPARATION } from "../src/theme/guard.js";
import { fontStack } from "../src/theme/fonts.js";
import { TEXT_FLOOR_PX, TEXT_SCALE, TYPE_SCALE, type TypeStep } from "../src/theme/primitives.js";
import { DEFAULT_PRESET, PRESETS } from "../src/theme/presets.js";
import type { Theme } from "../src/theme/types.js";

/*
 * The theme system is the one place a plausible-looking number breaks the
 * legibility floor or the status vocabulary without any render failing, so
 * this is where the cheap proofs live (docs/ux-theme.md T2, T3, T5).
 */

describe("colour math", () => {
  it("round-trips hex through parse and back", () => {
    expect(parseColor("#4da3ff")).toEqual({ r: 0x4d / 255, g: 0xa3 / 255, b: 0xff / 255 });
    expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseColor("rgb(255 0 0)")).toEqual({ r: 1, g: 0, b: 0 });
    expect(parseColor("var(--ink)")).toBeNull();
  });
  it("measures WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
    expect(Number.isNaN(contrastRatio("var(--x)", "#fff"))).toBe(true);
  });
  it("oklch lands in gamut and keeps its hue", () => {
    const hex = oklch(0.78, 0.13, 255);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(Math.abs(hueOf(hex)! - 255)).toBeLessThan(3);
    // out of gamut chroma is clipped, not wrapped: the result is still hue ~150
    expect(Math.abs(hueOf(oklch(0.9, 0.4, 150))! - 150)).toBeLessThan(6);
  });
  it("raises a colour until it clears its grounds and no further than needed", () => {
    const raised = raiseContrast("#8393a3", ["#1a222d"], 7, "lighter");
    expect(contrastRatio(raised, "#1a222d")).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(raised, "#1a222d")).toBeLessThan(8);
    expect(raiseContrast("#ffffff", ["#000000"], 7, "lighter")).toBe("#ffffff");
  });
});

describe("every preset (T5: the default must be good, and so must the rest)", () => {
  for (const preset of PRESETS) {
    describe(preset.id, () => {
      const t = resolveTokens(preset);
      it("passes the guard with no errors", () => {
        expect(checkTheme(preset).filter((i) => i.level === "error")).toEqual([]);
        expect(isApplicable(preset)).toBe(true);
      });
      it("keeps every text token at or above its contrast target on every ground", () => {
        const target = CONTRAST_TARGET[preset.contrast];
        for (const text of TEXT_TOKENS) {
          for (const ground of GROUND_TOKENS) {
            expect(contrastRatio(t[text], t[ground]), `${text} on ${ground}`).toBeGreaterThanOrEqual(target);
          }
        }
      });
      it("keeps the on-colours readable on their fills", () => {
        for (const [fill, on] of [
          ["live", "on-live"],
          ["attention", "on-attention"],
          ["danger", "on-danger"],
          ["ok", "on-ok"],
        ] as const) {
          expect(contrastRatio(t[on], t[fill]), `${on} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("keeps attention away from the accent hue (T3)", () => {
        expect(hueDistance(hueOf(t.live)!, hueOf(t.attention)!)).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION);
      });
      it("keeps the ANSI colours legible on the terminal ground", () => {
        for (let i = 0; i < 16; i++) {
          expect(contrastRatio(t[`ansi-${i as 0}`], t["terminal-bg"]), `ansi-${i}`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("writes only measurable colours and pixel sizes", () => {
        const vars = compileVars(preset);
        for (const [k, v] of Object.entries(vars)) {
          if (k.startsWith("--shadow") || k.startsWith("--font") || k === "--motion-ease" || k === "color-scheme" || k === "--text-scale") continue;
          expect(v, k).toMatch(/^(#[0-9a-f]{6}|[\d.]+px|[\d.]+ms)$/);
        }
      });
    });
  }
});

describe("the legibility floor (T2)", () => {
  it("never scales data under 12px at any text size, and the eyebrow never under 11", () => {
    for (const scale of Object.values(TEXT_SCALE)) {
      for (const step of Object.keys(TYPE_SCALE) as TypeStep[]) {
        const { size, leading } = scaledType(step, scale);
        expect(size).toBeGreaterThanOrEqual(step === "2xs" ? 11 : TEXT_FLOOR_PX);
        expect(leading).toBeGreaterThanOrEqual(size);
        expect(Number.isInteger(size)).toBe(true);
      }
    }
    expect(scaledType("xs", TEXT_SCALE.small).size).toBe(12);
    expect(scaledType("base", TEXT_SCALE.larger).size).toBe(17);
  });
  it("orders the scale at every setting", () => {
    for (const scale of Object.values(TEXT_SCALE)) {
      const sizes = (["xs", "sm", "base", "md", "lg", "xl", "2xl"] as TypeStep[]).map((s) => scaledType(s, scale).size);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    }
  });
});

describe("guard rails", () => {
  const broken = (patch: Partial<Theme["tokens"]>, rest: Partial<Theme> = {}): Theme => ({
    ...DEFAULT_PRESET,
    ...rest,
    tokens: { ...DEFAULT_PRESET.tokens, ...patch },
  });
  it("flags text that fails 4.5:1 on any ground", () => {
    const issues = checkTheme(broken({ "ink-3": "#555555" }));
    expect(issues.some((i) => i.level === "error" && i.token === "ink-3")).toBe(true);
  });
  it("refuses attention on the accent hue", () => {
    const issues = checkTheme(broken({ attention: DEFAULT_PRESET.tokens.live }));
    expect(issues.some((i) => i.level === "error" && i.token === "attention")).toBe(true);
    expect(isApplicable(broken({ attention: DEFAULT_PRESET.tokens.live }))).toBe(false);
  });
  it("flags a value that is not a colour", () => {
    expect(checkTheme(broken({ live: "var(--x)" }))[0]).toMatchObject({ level: "error", token: "live" });
  });
  it("high contrast raises text to 7:1 without the person touching a token", () => {
    const t = resolveTokens({ ...DEFAULT_PRESET, contrast: "high" });
    for (const text of TEXT_TOKENS) {
      for (const ground of GROUND_TOKENS) expect(contrastRatio(t[text], t[ground])).toBeGreaterThanOrEqual(7);
    }
  });
  it("rotates attention off the accent hue", () => {
    expect(hueDistance(80, separateAttention(80, 85))).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION);
    expect(separateAttention(255, 80)).toBe(80);
  });
  it("reduced motion zeroes every duration", () => {
    const vars = compileVars({ ...DEFAULT_PRESET, motion: "reduced" });
    expect(vars["--motion-morph"]).toBe("0ms");
    expect(vars["--motion-instant"]).toBe("0ms");
  });
});

describe("fonts", () => {
  it("puts the metric-matched fallback right after the real family", () => {
    expect(fontStack("inter", "sans")).toMatch(/^"Inter", "Inter Fallback", ui-sans-serif/);
    expect(fontStack("jetbrains-mono", "mono")).toMatch(/^"JetBrains Mono", "JetBrains Mono Fallback", ui-monospace/);
  });
  it("gives the system choice no webfont at all", () => {
    expect(fontStack("system-sans", "sans")).toMatch(/^ui-sans-serif/);
  });
  it("treats an unknown id as a Google family", () => {
    expect(fontStack("Lexend", "sans")).toMatch(/^"Lexend", ui-sans-serif/);
  });
});

/*
 * globals.css carries the default preset's compiled values as the `:root`
 * fallback for the moment before the boot script or the store runs (and for
 * a fresh install, which has nothing stored). Those literals are the one
 * copy of a preset outside src/theme, so they must equal what the compiler
 * produces. When this fails the expected block is written to the scratchpad
 * path printed below; paste it over the `:root` block.
 */
describe("globals.css :root is the compiled default preset", () => {
  it("matches compileTheme(DEFAULT_PRESET) exactly", () => {
    const css = readFileSync(new URL("../src/globals.css", import.meta.url), "utf8");
    const m = /\/\* @theme-default-start \*\/([\s\S]*?)\/\* @theme-default-end \*\//.exec(css);
    const compiled = compileTheme(DEFAULT_PRESET);
    const expected = Object.entries(compiled.vars)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    // Not `.trim()` on the whole capture: that eats the first line's own
    // indentation and nothing else's, so the comparison can never succeed.
    // Blank lines go in the filter below, which is where they belong.
    const actual = m ? m[1]!.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !l.trim().startsWith("/*")).join("\n") : "";
    if (actual !== expected) {
      const out = process.env["PIORBIT_SCRATCH"] ?? "/tmp/claude-1000/-home-youssef-projects-piorbit/f5becb6f-83f1-4c52-8634-118bcac40929/scratchpad";
      try {
        writeFileSync(`${out}/theme-default-root.css`, expected + "\n");
      } catch {
        /* scratchpad not present in CI: the diff below is enough */
      }
    }
    expect(actual).toBe(expected);
  });
});
