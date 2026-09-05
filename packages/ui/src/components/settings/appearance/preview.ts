/**
 * Turning a `Theme` into an inline style, so a swatch card can render itself
 * in its own tokens (M11-T3) without touching the page's theme.
 *
 * `compileVars` is the same function the applier uses, so a preset card is
 * not an approximation of the preset — it is the preset, scoped to one
 * element. The one translation is `color-scheme`: React assigns non-custom
 * properties by JS name, so the compiler's CSS spelling has to become
 * `colorScheme` or it is silently dropped.
 */
import type { CSSProperties } from "react";

import { compileVars, type Theme } from "@/theme";

export function themeStyle(theme: Theme): CSSProperties {
  const vars = compileVars(theme);
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (name.startsWith("--")) style[name] = value;
  }
  return { ...style, colorScheme: theme.base } as CSSProperties;
}
