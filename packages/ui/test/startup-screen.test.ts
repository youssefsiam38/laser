/**
 * The opening screen is drawn twice — by React here, and by the desktop shell
 * as a standalone document before this bundle exists — and the whole point of
 * M13-T32 is that a person sees one screen rather than two. These are the
 * checks that keep the two drawings the same one.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ENV } from "@lasercode/protocol";
import {
  STARTUP_SCREEN_BASE_TOKENS,
  STARTUP_SCREEN_CSS,
  STARTUP_SCREEN_FALLBACK_GROUND,
  STARTUP_SCREEN_TOKEN_NAMES,
  startupScreenPageHtml,
} from "@lasercode/protocol/startup-screen";

import { StartupRestorationScreen } from "../src/components/assistant-ui/elements/loading-state.js";
import { productIdentityHtml } from "../src/pwa/vite-plugin.js";
import { startupTokensOf } from "../src/theme/apply.js";
import { compileTheme } from "../src/theme/compile.js";
import { DEFAULT_LIGHT_PRESET_ID, DEFAULT_PRESET, getPreset } from "../src/theme/presets.js";
import type { Theme, ThemePreset } from "../src/theme/types.js";

const globals = readFileSync(new URL("../src/globals.css", import.meta.url), "utf8");

const asTheme = (preset: ThemePreset): Theme => {
  const { tagline: _tagline, ...theme } = preset;
  return theme;
};

const compiledVars = (preset: ThemePreset): Record<string, string> => compileTheme(asTheme(preset)).vars;

/** Every `--name: value;` in globals.css, last one wins (the type scale). */
function globalsToken(name: string): string | undefined {
  const matches = [...globals.matchAll(new RegExp(`^\\s*${name.replaceAll("-", "\\-")}:\\s*([^;]+);`, "gm"))];
  return matches.at(-1)?.[1]?.trim();
}

describe("globals.css carries the shared opening-screen rules", () => {
  it("matches STARTUP_SCREEN_CSS exactly", () => {
    const block = /\/\* @startup-screen-start \*\/\n([\s\S]*?)\n\/\* @startup-screen-end \*\//.exec(globals);
    const actual = block?.[1] ?? "";
    if (actual !== STARTUP_SCREEN_CSS) {
      // Same courtesy as the theme block: hand over the text to paste, when a
      // scratch directory was asked for.
      const out = process.env[ENV.scratch];
      if (out !== undefined && out !== "") {
        try {
          writeFileSync(`${out}/startup-screen.css`, `${STARTUP_SCREEN_CSS}\n`);
        } catch {
          /* not writable: the diff below is enough */
        }
      }
    }
    expect(actual).toBe(STARTUP_SCREEN_CSS);
  });
});

describe("the fallback ground is the default presets, not a second palette", () => {
  it("matches the compiled default dark preset", () => {
    const vars = compiledVars(DEFAULT_PRESET);
    for (const [name, value] of Object.entries(STARTUP_SCREEN_FALLBACK_GROUND.dark)) {
      expect([name, value]).toEqual([name, vars[name]]);
    }
  });

  it("matches the compiled default light preset", () => {
    const vars = compiledVars(getPreset(DEFAULT_LIGHT_PRESET_ID)!);
    for (const [name, value] of Object.entries(STARTUP_SCREEN_FALLBACK_GROUND.light)) {
      expect([name, value]).toEqual([name, vars[name]]);
    }
  });

  it("takes every size, duration and typeface from the same source too", () => {
    const vars = compiledVars(DEFAULT_PRESET);
    for (const [name, value] of Object.entries(STARTUP_SCREEN_BASE_TOKENS)) {
      // `--tracking-title` is not a themeable token: globals.css's type scale
      // owns it, so that is what it is pinned to.
      expect([name, value]).toEqual([name, vars[name] ?? globalsToken(name)]);
    }
  });

  it("covers every declaration the screen reads", () => {
    const covered = new Set([
      ...Object.keys(STARTUP_SCREEN_BASE_TOKENS),
      ...Object.keys(STARTUP_SCREEN_FALLBACK_GROUND.dark),
    ]);
    expect(STARTUP_SCREEN_TOKEN_NAMES.filter((name) => !covered.has(name))).toEqual([]);
    // And nothing is declared that the rules never mention.
    for (const name of STARTUP_SCREEN_TOKEN_NAMES) {
      if (name === "color-scheme") continue;
      expect([name, STARTUP_SCREEN_CSS.includes(`var(${name})`)]).toEqual([name, true]);
    }
  });
});

const pathsIn = (markup: string): string[] => [...markup.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);

describe("the standalone page and the app draw the same screen", () => {
  const page = startupScreenPageHtml({
    title: "Product",
    label: "Starting your workspace",
    tokens: { ...STARTUP_SCREEN_BASE_TOKENS, ...STARTUP_SCREEN_FALLBACK_GROUND.dark },
    pair: STARTUP_SCREEN_FALLBACK_GROUND,
  });
  const app = renderToStaticMarkup(createElement(StartupRestorationScreen, { label: "Connecting to your workspace" }));

  it("draws the same beams and the same mark, in the same order", () => {
    expect(pathsIn(page)).toEqual(pathsIn(app));
    expect(pathsIn(page).length).toBe(6 + 6 + 5);
  });

  it("carries the same rules the app's stylesheet does", () => {
    expect(page).toContain(STARTUP_SCREEN_CSS);
    expect(page.match(/pathLength="1"/g)).toHaveLength(6);
  });

  it("writes no colour of its own: every literal is a declared token", () => {
    const declarations = page.slice(page.indexOf("<style>"), page.indexOf("* { box-sizing"));
    const outside = page.replace(declarations, "");
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });

  it("says what is happening, and is draggable as a frameless window", () => {
    expect(page).toContain('aria-label="Starting your workspace"');
    expect(page).toContain("Starting your workspace</p>");
    expect(page).toContain("-webkit-app-region: drag");
  });

  it("keeps something on screen for a person who asked for less motion", () => {
    expect(page).toContain("@media (prefers-reduced-motion: reduce)");
    // Stillness, not blankness: the mark, the beams and the track stay.
    expect(page).not.toContain("display: none");
  });

  it("escapes what it is given", () => {
    const nasty = startupScreenPageHtml({
      title: '</style><script>x</script>',
      label: '"><img>',
      tokens: STARTUP_SCREEN_FALLBACK_GROUND.dark,
    });
    expect(nasty).not.toContain("<script>");
    expect(nasty).not.toContain('<img>');
  });
});

describe("the document paints the screen before the bundle runs", () => {
  const shell = (html: string): string => {
    const plugin = productIdentityHtml();
    const transform = plugin.transformIndexHtml as (value: string) => string;
    return transform(html);
  };

  it("fills #root with the same scene the app mounts", () => {
    const html = shell('<body><div id="root">%STARTUP_SCREEN%</div></body>');
    const app = renderToStaticMarkup(createElement(StartupRestorationScreen, { label: "Connecting to your workspace" }));
    expect(pathsIn(html)).toEqual(pathsIn(app));
    expect(html).toContain('class="startup-restoration" data-continuing');
    expect(html).toContain("Connecting to your workspace");
  });

  it("paints the first frame in the compiled default ground, not a written-down hex", () => {
    const html = shell("<html><body>%THEME_DEFAULT_BG%</body></html>");
    expect(html).toContain(compiledVars(DEFAULT_PRESET)["--bg"]!);
  });
});

describe("taking over what is already on the glass", () => {
  it("does not fade in on the first mount, and does on a later one", async () => {
    vi.resetModules();
    const { StartupRestorationScreen: Screen } = await import(
      "../src/components/assistant-ui/elements/loading-state.js"
    );
    const first = renderToStaticMarkup(createElement(Screen, { label: "Connecting to your workspace" }));
    const later = renderToStaticMarkup(createElement(Screen, { label: "Returning to your last session" }));
    expect(first).toContain("data-continuing");
    expect(later).not.toContain("data-continuing");
    // And the copy that fades out is never marked: its animation is what tells
    // the gate when to unmount it.
    const exiting = renderToStaticMarkup(createElement(Screen, { label: "Connecting", exiting: true }));
    expect(exiting).not.toContain("data-continuing");
    expect(STARTUP_SCREEN_CSS).toContain(".startup-restoration[data-continuing]");
  });
});

describe("handing the shell what to paint the opening screen with", () => {
  const entry = (id: string, base: "dark" | "light", bg: string) => ({
    id,
    base,
    bg,
    css: `--bg: ${bg}; --ink: #ffffff; --live: #03cc7b; --surface: #111111;`,
  });
  const blob = {
    v: 1 as const,
    followSystem: true,
    active: entry("a", "dark", "#000000"),
    dark: entry("a", "dark", "#000000"),
    light: entry("b", "light", "#ffffff"),
  };

  it("sends the applied theme and both halves of the pair", async () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>)["desktop"] = {
      setTheme: (...args: unknown[]) => calls.push(args),
    };
    try {
      const { writeBootBlob } = await import("../src/theme/apply.js");
      writeBootBlob(blob);
    } finally {
      delete (globalThis as Record<string, unknown>)["desktop"];
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("dark");
    expect(calls[0]?.[1]).toEqual({
      followSystem: true,
      active: { "--bg": "#000000", "--ink": "#ffffff", "--live": "#03cc7b" },
      dark: { "--bg": "#000000", "--ink": "#ffffff", "--live": "#03cc7b" },
      light: { "--bg": "#ffffff", "--ink": "#ffffff", "--live": "#03cc7b" },
    });
  });

  it("says nothing at all in a browser tab, and never throws", async () => {
    const { writeBootBlob } = await import("../src/theme/apply.js");
    expect(() => writeBootBlob(blob)).not.toThrow();
  });
});

describe("startupTokensOf", () => {
  it("picks exactly the declarations the screen reads", () => {
    const css = "--bg: #000000; --text-xl: 22px; --text-xl--line-height: 28px; --surface: #171717; color-scheme: dark;";
    expect(startupTokensOf(css)).toEqual({
      "--bg": "#000000",
      "--text-xl": "22px",
      "--text-xl--line-height": "28px",
      "color-scheme": "dark",
    });
  });

  it("survives a theme that declares none of them", () => {
    expect(startupTokensOf("--surface: #171717;")).toEqual({});
  });
});
