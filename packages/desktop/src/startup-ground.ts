/**
 * What the opening screen is painted with, remembered between launches
 * (M13-T32).
 *
 * The app shows the mark with the beams while it restores a session. The shell
 * has to show the *same* screen before the app exists — while the host is
 * starting — and that document has an opaque origin: it cannot read the theme
 * out of browser storage the way the app's own boot script does. So the app
 * hands the few declarations that screen needs to the main process whenever it
 * applies a theme, and they are kept here beside the window state.
 *
 * A first launch has nothing recorded and gets the default presets, which is
 * what the app is about to paint anyway.
 *
 * The values arrive from the renderer and are written into a `<style>`, so
 * they are validated rather than trusted: known declaration names only, and a
 * value shape that cannot leave the declaration it is in.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STARTUP_SCREEN_BASE_TOKENS,
  STARTUP_SCREEN_FALLBACK_GROUND,
  STARTUP_SCREEN_TOKEN_NAMES,
  type StartupScreenTokens,
} from "@lasercode/protocol/startup-screen";

export interface StartupGround {
  /** The person follows the desktop's light/dark setting; the pair is live. */
  followSystem: boolean;
  /** The theme actually applied when this was recorded. */
  active: StartupScreenTokens;
  dark: StartupScreenTokens;
  light: StartupScreenTokens;
}

/** Anything that could end the declaration, the rule or the style element. */
const UNSAFE_VALUE = /[<>{};@\\]/;

function tokens(value: unknown): StartupScreenTokens | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const name of STARTUP_SCREEN_TOKEN_NAMES) {
    const token = source[name];
    if (typeof token !== "string") continue;
    const trimmed = token.trim();
    if (trimmed === "" || trimmed.length > 200 || UNSAFE_VALUE.test(trimmed)) continue;
    out[name] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate what the renderer sent, or what an older file holds. */
export function parseStartupGround(value: unknown): StartupGround | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const active = tokens(source["active"]);
  const dark = tokens(source["dark"]);
  const light = tokens(source["light"]);
  if (!active || !dark || !light) return undefined;
  return { followSystem: source["followSystem"] === true, active, dark, light };
}

const fileFor = (stateDir: string): string => join(stateDir, "startup-screen.json");

export function readStartupGround(stateDir: string): StartupGround | undefined {
  try {
    return parseStartupGround(JSON.parse(readFileSync(fileFor(stateDir), "utf8")));
  } catch {
    // No record yet, or an unreadable one: the default presets are correct.
    return undefined;
  }
}

/** Returns true when something changed and was written. */
export function writeStartupGround(stateDir: string, ground: StartupGround): boolean {
  const file = fileFor(stateDir);
  const text = `${JSON.stringify(ground, null, 2)}\n`;
  try {
    if (readFileSync(file, "utf8") === text) return false;
  } catch {
    /* no record yet */
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return true;
  } catch {
    // Losing the recorded ground costs one launch in the default preset.
    return false;
  }
}

/** The declarations in force right now, given what the desktop is set to. */
export function activeGround(ground: StartupGround | undefined, systemDark: boolean): StartupScreenTokens {
  const fallback = STARTUP_SCREEN_FALLBACK_GROUND[systemDark ? "dark" : "light"];
  if (!ground) return { ...STARTUP_SCREEN_BASE_TOKENS, ...fallback };
  const chosen = ground.followSystem ? (systemDark ? ground.dark : ground.light) : ground.active;
  return { ...STARTUP_SCREEN_BASE_TOKENS, ...fallback, ...chosen };
}

/**
 * The pair the standalone page switches between with `prefers-color-scheme`,
 * or nothing when the person has chosen a theme for themselves. Following the
 * desktop is the default, and the setting can change while the screen is up.
 */
export function groundPair(
  ground: StartupGround | undefined,
): Record<"dark" | "light", StartupScreenTokens> | undefined {
  if (ground && !ground.followSystem) return undefined;
  return {
    dark: { ...STARTUP_SCREEN_FALLBACK_GROUND.dark, ...(ground?.dark ?? {}) },
    light: { ...STARTUP_SCREEN_FALLBACK_GROUND.light, ...(ground?.light ?? {}) },
  };
}

const COLOUR = /^#[0-9a-fA-F]{3,8}$/;

/**
 * The window's own background and its title-bar symbols, so the frame matches
 * the page before the page exists. Electron takes a colour string, not a
 * token, so anything that is not plainly one falls back to the preset.
 */
export function frameColours(
  ground: StartupGround | undefined,
  systemDark: boolean,
): { background: string; ink: string } {
  const active = activeGround(ground, systemDark);
  const fallback = STARTUP_SCREEN_FALLBACK_GROUND[systemDark ? "dark" : "light"];
  const pick = (name: "--bg" | "--ink"): string => {
    const value = active[name];
    return value && COLOUR.test(value) ? value : (fallback[name] as string);
  };
  return { background: pick("--bg"), ink: pick("--ink") };
}
