/**
 * @lasercode/ui theme system — public surface. docs/ux-theme.md is the spec.
 *
 * Components read CSS custom properties, never this module. Settings, the
 * rail toggle and the highlighter read the store or the hook. Presets and
 * primitives are exported for the gallery and the editor.
 */
export type {
  Theme,
  ThemePreset,
  ThemeBase,
  ThemeTokens,
  ColorTokenName,
  OptionalColorTokenName,
  FontChoice,
  Density,
  Radius,
  Contrast,
  Motion,
  TextSize,
  CompiledTheme,
} from "./types.js";

export { PRESETS, DEFAULT_PRESET, DEFAULT_PRESET_ID, DEFAULT_LIGHT_PRESET_ID, getPreset, presetsFor } from "./presets.js";

export { compileTheme, compileVars, resolveTokens, scaledType, textFloorPx, varsToCss, CONTRAST_TARGET, TEXT_TOKENS, GROUND_TOKENS } from "./compile.js";

export { applyCompiled, bootEntry, readBootBlob, writeBootBlob, THEME_STORAGE_KEY, THEME_STYLE_ID, THEME_SELECTOR } from "./apply.js";
export type { BootBlob, BootEntry } from "./apply.js";

export { themeStore, DEFAULT_STATE } from "./store.js";
export type { ThemeState } from "./store.js";

export { useTheme, useThemeBase } from "./use-theme.js";
export type { UseTheme } from "./use-theme.js";

export { checkTheme, isApplicable, contrastOf, separateAttention, MIN_CONTRAST, MIN_TEXT_PX, MIN_HUE_SEPARATION } from "./guard.js";
export type { ThemeIssue } from "./guard.js";

export { contrastRatio, parseColor, toHex, oklch, hueOf, hueDistance, raiseContrast, pickOnColor } from "./color.js";

export {
  INTERFACE_FONTS,
  CODE_FONTS,
  DEFAULT_FONTS,
  fontEntry,
  fontStack,
  ensureFontLoaded,
  googleFontsHref,
  fallbackFace,
} from "./fonts.js";
export type { FontEntry, FontKind, FontSource } from "./fonts.js";

export {
  ACCENT_HUES,
  accentRamp,
  attentionRamp,
  neutralRamp,
  NEUTRAL_TINT,
  NEUTRAL_LIGHTNESS,
  TYPE_SCALE,
  TEXT_SCALE,
  TEXT_FLOOR_PX,
  EYEBROW_FLOOR_PX,
  SPACE_UNIT,
  RADIUS_BASE,
  DURATIONS,
} from "./primitives.js";
export type { AccentHueName, NeutralFamily, TypeStep } from "./primitives.js";
