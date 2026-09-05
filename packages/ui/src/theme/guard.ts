/**
 * Guard rails (docs/ux-theme.md T2, T3). An editor calls `checkTheme` on every
 * keystroke and shows the issues next to the field; the store refuses to
 * apply a theme with an `error`. Warnings apply, flagged.
 */
import { contrastRatio, hueDistance, hueOf, parseColor } from "./color.js";
import { CONTRAST_TARGET, GROUND_TOKENS, TEXT_TOKENS, resolveTokens, scaledType } from "./compile.js";
import { TEXT_FLOOR_PX, TEXT_SCALE, TYPE_SCALE, type TypeStep } from "./primitives.js";
import type { Theme } from "./types.js";

export const MIN_CONTRAST = CONTRAST_TARGET.normal;
export const MIN_TEXT_PX = TEXT_FLOOR_PX;
/** Attention and accent hues closer than this read as one colour. */
export const MIN_HUE_SEPARATION = 40;

export type ThemeIssue = {
  level: "error" | "warning";
  /** The token at fault, `--`-less, or `textSize` for the scale. */
  token: string;
  message: string;
  /** Measured value when there is one (a ratio, a hue distance, a px size). */
  measured?: number;
};

/** Contrast readout for one token against one ground, for the editor's per-field label. */
export function contrastOf(theme: Theme, token: string, ground: string = "surface-2"): number {
  const t = resolveTokens(theme) as Record<string, string>;
  return contrastRatio(t[token] ?? "", t[ground] ?? "");
}

export function checkTheme(theme: Theme): ThemeIssue[] {
  const issues: ThemeIssue[] = [];
  const raw = theme.tokens as Record<string, string | undefined>;

  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (name.startsWith("shadow-")) continue;
    if (!parseColor(value)) {
      issues.push({ level: "error", token: name, message: `“${value}” is not a colour I can measure. Use #rrggbb, rgb() or oklch().` });
    }
  }
  if (issues.length) return issues;

  const t = resolveTokens(theme);
  const target = CONTRAST_TARGET[theme.contrast];

  // T2: every text token clears every ground. `resolveTokens` already raised
  // them under high contrast; here we report what the *authored* values do,
  // so a person editing sees the truth of their number, not the fix.
  for (const name of TEXT_TOKENS) {
    for (const ground of GROUND_TOKENS) {
      const ratio = contrastRatio(theme.tokens[name], theme.tokens[ground]);
      if (ratio < MIN_CONTRAST) {
        issues.push({
          level: "error",
          token: name,
          measured: round(ratio),
          message: `${name} on ${ground} is ${round(ratio)}:1; text needs ${MIN_CONTRAST}:1.`,
        });
      } else if (ratio < target) {
        issues.push({
          level: "warning",
          token: name,
          measured: round(ratio),
          message: `${name} on ${ground} is ${round(ratio)}:1; high contrast raises it to ${target}:1.`,
        });
      }
    }
  }

  // T3: attention may never share the accent's hue.
  const liveHue = hueOf(t.live);
  const attentionHue = hueOf(t.attention);
  if (liveHue === null || attentionHue === null) {
    issues.push({
      level: "error",
      token: liveHue === null ? "live" : "attention",
      message: `${liveHue === null ? "live" : "attention"} is a grey; a status colour needs a hue so it can be told apart.`,
    });
  } else {
    const d = hueDistance(liveHue, attentionHue);
    if (d < MIN_HUE_SEPARATION) {
      issues.push({
        level: "error",
        token: "attention",
        measured: round(d),
        message: `attention and live are ${round(d)}° apart; “needs you” must never look like “running”. Move one at least ${MIN_HUE_SEPARATION}° away.`,
      });
    }
  }
  // Danger and ok are the other fixed meanings; they should not collide with live either.
  for (const name of ["danger", "ok"] as const) {
    const h = hueOf(t[name]);
    if (h !== null && liveHue !== null && hueDistance(h, liveHue) < MIN_HUE_SEPARATION) {
      issues.push({ level: "warning", token: name, measured: round(hueDistance(h, liveHue)), message: `${name} sits within ${MIN_HUE_SEPARATION}° of live; the two states will look alike.` });
    }
  }

  // The floor: no data below 12px at any text size. `scaledType` clamps, so
  // this can only fail if someone edits the scale; it is here so the editor
  // can show "12px, the floor" under the small setting.
  for (const step of Object.keys(TYPE_SCALE) as TypeStep[]) {
    if (step === "2xs") continue;
    const { size } = scaledType(step, TEXT_SCALE[theme.textSize]);
    if (size < MIN_TEXT_PX) {
      issues.push({ level: "error", token: "textSize", measured: size, message: `${step} would be ${size}px; nothing read as data goes under ${MIN_TEXT_PX}px.` });
    }
  }

  return issues;
}

/** True when the theme may be applied: no `error`-level issue. */
export function isApplicable(theme: Theme): boolean {
  return !checkTheme(theme).some((i) => i.level === "error");
}

/**
 * Enforces T3 mechanically: if `attention` lands on the accent's hue, rotate
 * it to the nearest allowed hue. Used by the accent picker so choosing an
 * amber accent moves attention rather than producing an invalid theme.
 */
export function separateAttention(liveHue: number, attentionHue: number): number {
  const d = hueDistance(liveHue, attentionHue);
  if (d >= MIN_HUE_SEPARATION) return attentionHue;
  const signed = ((attentionHue - liveHue + 540) % 360) - 180;
  const dir = signed >= 0 ? 1 : -1;
  return (liveHue + dir * MIN_HUE_SEPARATION + 360) % 360;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
