import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computeKeyboardInset } from "../src/hooks/use-keyboard-inset.js";
import { aggregateStatus, statusRank, toneForPercent } from "../src/components/status/status.js";

describe("computeKeyboardInset", () => {
  it("uses docHeight - vv.height - vv.offsetTop, clamped at 0", () => {
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300);
    expect(computeKeyboardInset(800, { height: 500, offsetTop: 100 })).toBe(200);
    expect(computeKeyboardInset(800, { height: 900, offsetTop: 0 })).toBe(0);
  });
  it("ignores browser-chrome jitter under the threshold", () => {
    expect(computeKeyboardInset(800, { height: 780, offsetTop: 0 })).toBe(0);
    expect(computeKeyboardInset(800, { height: 780, offsetTop: 0 }, 10)).toBe(20);
  });
});

describe("status vocabulary", () => {
  it("ranks waiting > error > finished_unread > working > idle", () => {
    expect(statusRank("waiting_for_input")).toBeLessThan(statusRank("error"));
    expect(statusRank("error")).toBeLessThan(statusRank("finished_unread"));
    expect(statusRank("finished_unread")).toBeLessThan(statusRank("working"));
    expect(statusRank("working")).toBeLessThan(statusRank("idle"));
  });
  it("aggregates to the most attention-worthy status", () => {
    expect(aggregateStatus([])).toBe("idle");
    expect(aggregateStatus(["idle", "working"])).toBe("working");
    expect(aggregateStatus(["working", "waiting_for_input", "error"])).toBe("waiting_for_input");
  });
});

describe("toneForPercent", () => {
  it("is calm below 70, warm below 90, danger at 90+", () => {
    expect(toneForPercent(0)).toBe("live");
    expect(toneForPercent(69)).toBe("live");
    expect(toneForPercent(70)).toBe("attention");
    expect(toneForPercent(90)).toBe("danger");
  });
});

/**
 * The legibility floor and the token system are binding (AGENTS.md,
 * DESIGN.md, docs/ux-panels.md R13) and both are trivially broken by one
 * plausible-looking class. Neither shows up as a failing render, so this is
 * the cheapest place to catch it.
 */
describe("the legibility floor and the palette", () => {
  const sources = sourceFiles(new URL("../src/", import.meta.url));

  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("renders no information below 12px, and takes every size from the scale", () => {
    // 11px is the eyebrow's size and the eyebrow's alone; it is applied by the
    // `eyebrow` utility, never by a size class. And the guard matches *any*
    // px literal, not only the small ones: `text-[13px]` is already in the
    // scale as `text-sm`, and a literal is a size the text-size setting cannot
    // move — which is the same bug one step later.
    const literalType = /\btext-2xs\b|\btext-\[\d+px\]|\bleading-\[\d+px\]/;
    const offenders = sources.filter(({ text }) => literalType.test(text)).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("takes every duration and easing from a motion token", () => {
    // A number in a class is a duration nobody can change in Settings, and a
    // `cubic-bezier(...)` spelled in a component is the same for easing.
    // `--motion-instant | fast | slow | morph` are the four there are.
    const literalMotion = /\bduration-(?:\d+|\[[^\]]+\])|\bease-\[[^\]]+\]|\bdelay-(?:\d+|\[[^\]]+\])/;
    const offenders = sources.filter(({ text }) => literalMotion.test(text)).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("animates only with the app's own keyframes, never Tailwind's defaults", () => {
    // `animate-spin`, `animate-pulse` and `animate-bounce` carry Tailwind's
    // built-in durations and easings, which no `--motion-*` token can reach —
    // the assertion above cannot see them, which is why they get their own.
    // The app's animations are declared in `globals.css` beside each other:
    // sweep, attention, caret, shimmer, busy.
    const defaultAnimation = /\banimate-(?:spin|pulse|bounce)\b/;
    const offenders = sources.filter(({ text }) => defaultAnimation.test(text)).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });

  it("takes every colour from the palette, not from a literal", () => {
    // Hex, rgb() and hsl() literals in a class or a style. `globals.css` is
    // where the palette is defined and is not scanned; the two documented
    // exceptions carry the reason next to them in the source.
    const literal = /(?:bg|text|border|fill|stroke|shadow|ring|outline|from|via|to)-\[#[0-9a-fA-F]{3,8}\]|#[0-9a-fA-F]{6}\b/;
    const allowed = new Set([
      // A mask's colour is its alpha channel, not something a person sees.
      "components/status/StatusRing.tsx",
      // The offline page renders when the stylesheet itself did not load.
      "pwa/sw.ts",
      // docs/ux-theme.md T1: "the only literals allowed are in the primitive
      // scales and the preset definitions". These two files are that place —
      // scanning them is scanning the palette for being a palette.
      "theme/primitives.ts",
      "theme/presets.ts",
    ]);
    const offenders = sources.filter(({ name, text }) => !allowed.has(name) && literal.test(text)).map(({ name }) => name);
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: URL): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const walk = (at: URL, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, at), `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ name: `${prefix}${entry.name}`, text: readFileSync(new URL(entry.name, at), "utf8") });
    }
  };
  walk(dir, "");
  return out;
}
