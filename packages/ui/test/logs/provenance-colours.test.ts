import { expect, it } from "vitest";
import { ORIGINS } from "@lasercode/protocol";
import { resolveTokens } from "../../src/theme/compile.js";
import { parseColor, rgbToOklch } from "../../src/theme/color.js";
import { PRESETS } from "../../src/theme/presets.js";

const lab = (hex: string) => {
  const { l, c, h } = rgbToOklch(parseColor(hex)!);
  return [l, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)];
};
const distance = (a: string, b: string) => {
  const left = lab(a), right = lab(b);
  return Math.hypot(...left.map((value, i) => value - right[i]!));
};

for (const preset of PRESETS) {
  it(`${preset.name}: every origin is perceptually distinct, and app is not the action ring`, () => {
    const tokens = resolveTokens(preset);
    for (const [i, origin] of ORIGINS.entries()) {
      for (const other of ORIGINS.slice(i + 1)) {
        // OKLab Euclidean distance: > 0.045, not just unequal hex values.
        expect(distance(tokens[origin.token], tokens[other.token]), `${origin.id} / ${other.id}`).toBeGreaterThan(0.045);
      }
    }
    expect(distance(tokens["provenance-app"], tokens.live)).toBeGreaterThan(0.08);
  });
}
