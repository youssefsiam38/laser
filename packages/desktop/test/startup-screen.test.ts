/**
 * One opening screen (M13-T32).
 *
 * The shell used to show a card with a progress bar while the host started,
 * and the app then replaced it with a different screen entirely. These check
 * that what the shell shows now is the app's own opening screen, in the
 * person's own colours, and that nothing a renderer sends can turn a recorded
 * theme into something else.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STARTUP_SCREEN_FALLBACK_GROUND,
  STARTUP_SCREEN_TOKEN_NAMES,
} from "@lasercode/protocol/startup-screen";

import { startingPageHtml, startingPageUrl, statusPageHtml } from "../src/error-page.js";
import {
  activeGround,
  frameColours,
  groundPair,
  parseStartupGround,
  readStartupGround,
  writeStartupGround,
  type StartupGround,
} from "../src/startup-ground.js";

const paper: StartupGround = {
  followSystem: false,
  active: { "color-scheme": "light", "--bg": "#f4f1ec", "--ink": "#1b1a17", "--live": "#b4531f" },
  dark: { "color-scheme": "dark", "--bg": "#101010", "--ink": "#eeeeee", "--live": "#03cc7b" },
  light: { "color-scheme": "light", "--bg": "#f4f1ec", "--ink": "#1b1a17", "--live": "#b4531f" },
};

const following: StartupGround = { ...paper, followSystem: true };

describe("the starting screen is the app's opening screen", () => {
  it("draws the mark and the beams, not a card with a progress bar", () => {
    const page = startingPageHtml(undefined, true);
    expect(page).toContain('class="startup-restoration"');
    expect(page).toContain('class="startup-beam-live"');
    expect(page.match(/pathLength="1"/g)).toHaveLength(6);
    expect(page).toContain('class="startup-mark"');
    expect(page).not.toContain("progressbar");
    expect(page).not.toContain("Try again");
  });

  it("is a data URL, so it works the same inside app.asar and in development", () => {
    const url = startingPageUrl(undefined, true);
    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toBe(startingPageHtml(undefined, true));
  });

  it("uses the default presets, and follows the desktop, when nothing is recorded", () => {
    const page = startingPageHtml(undefined, true);
    expect(page).toContain(`--bg: ${STARTUP_SCREEN_FALLBACK_GROUND.dark["--bg"]};`);
    expect(page).toContain("@media (prefers-color-scheme: light)");
    expect(page).toContain(`--live: ${STARTUP_SCREEN_FALLBACK_GROUND.light["--live"]};`);
  });

  it("uses the person's own theme once the app has recorded one", () => {
    const page = startingPageHtml(paper, true);
    // Their chosen theme wins over what the desktop is set to, exactly as it
    // does in the app: there is no pair to switch between.
    expect(page).toContain("--bg: #f4f1ec;");
    expect(page).not.toContain("@media (prefers-color-scheme: light)");
  });

  it("switches with the desktop while the person is following it", () => {
    const page = startingPageHtml(following, false);
    expect(page).toContain("@media (prefers-color-scheme: dark)");
    expect(page).toContain("--bg: #101010;");
    expect(page).toContain("--bg: #f4f1ec;");
  });
});

describe("the screen that says the host could not start", () => {
  it("is unchanged: a title, a message, the log and a way to try again", () => {
    const page = statusPageHtml({ title: "Cannot start", message: "Something stopped it.", logFile: "/tmp/host.log" });
    expect(page).toContain("Cannot start");
    expect(page).toContain("Try again");
    expect(page).toContain("/tmp/host.log");
    // The waiting variant is gone; nothing here animates a progress bar.
    expect(page).not.toContain("progressbar");
  });
});

describe("what the renderer sends is validated, not trusted", () => {
  it("keeps only known declarations", () => {
    const parsed = parseStartupGround({
      followSystem: false,
      active: { "--bg": "#000000", "--surface": "#111111" },
      dark: { "--bg": "#000000" },
      light: { "--bg": "#ffffff" },
    });
    expect(parsed?.active).toEqual({ "--bg": "#000000" });
  });

  it("refuses a value that could leave its declaration", () => {
    const parsed = parseStartupGround({
      followSystem: false,
      active: { "--bg": "#000000; } body { display: none", "--ink": "#ffffff" },
      dark: { "--bg": "#000000" },
      light: { "--bg": "#ffffff" },
    });
    expect(parsed?.active).toEqual({ "--ink": "#ffffff" });
    expect(startingPageHtml(parsed, true)).not.toContain("display: none");
  });

  it("refuses anything that is not a complete record", () => {
    expect(parseStartupGround(undefined)).toBeUndefined();
    expect(parseStartupGround("dark")).toBeUndefined();
    expect(parseStartupGround({ followSystem: true, active: {}, dark: {}, light: {} })).toBeUndefined();
    expect(parseStartupGround({ followSystem: true, active: { "--bg": "#000000" } })).toBeUndefined();
  });

  it("names every declaration the screen actually reads", () => {
    expect(STARTUP_SCREEN_TOKEN_NAMES).toContain("--bg");
    expect(STARTUP_SCREEN_TOKEN_NAMES).toContain("--live");
    expect(STARTUP_SCREEN_TOKEN_NAMES).toContain("--font-sans");
  });
});

describe("the recorded ground", () => {
  it("round-trips through the state directory, and skips an identical write", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-ground-"));
    expect(readStartupGround(dir)).toBeUndefined();
    expect(writeStartupGround(dir, paper)).toBe(true);
    expect(readStartupGround(dir)).toEqual(paper);
    expect(writeStartupGround(dir, paper)).toBe(false);
    expect(writeStartupGround(dir, following)).toBe(true);
    expect(readStartupGround(dir)?.followSystem).toBe(true);
  });

  it("ignores a file somebody else wrote", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-ground-"));
    writeFileSync(join(dir, "startup-screen.json"), "not json at all");
    expect(readStartupGround(dir)).toBeUndefined();
    writeFileSync(join(dir, "startup-screen.json"), JSON.stringify({ followSystem: true }));
    expect(readStartupGround(dir)).toBeUndefined();
  });

  it("is written as a whole file, ending in a newline", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-ground-"));
    writeStartupGround(dir, paper);
    expect(readFileSync(join(dir, "startup-screen.json"), "utf8").endsWith("}\n")).toBe(true);
  });
});

describe("the window frame", () => {
  it("is the app's ground, not a copy of an older palette", () => {
    expect(frameColours(paper, true)).toEqual({ background: "#f4f1ec", ink: "#1b1a17" });
    expect(frameColours(following, true).background).toBe("#101010");
    expect(frameColours(following, false).background).toBe("#f4f1ec");
  });

  it("falls back to the default preset before anything is recorded", () => {
    expect(frameColours(undefined, true)).toEqual({
      background: STARTUP_SCREEN_FALLBACK_GROUND.dark["--bg"],
      ink: STARTUP_SCREEN_FALLBACK_GROUND.dark["--ink"],
    });
    expect(frameColours(undefined, false).background).toBe(STARTUP_SCREEN_FALLBACK_GROUND.light["--bg"]);
  });

  it("refuses a ground Electron could not paint", () => {
    const odd = parseStartupGround({ ...paper, active: { "--bg": "var(--somewhere-else)" } });
    expect(frameColours(odd, true).background).toBe(STARTUP_SCREEN_FALLBACK_GROUND.dark["--bg"]);
  });
});

describe("resolving a ground", () => {
  it("fills in every base declaration the record does not carry", () => {
    const resolved = activeGround(paper, true);
    expect(resolved["--space-unit"]).toBeDefined();
    expect(resolved["--font-sans"]).toBeDefined();
    expect(resolved["--ink-2"]).toBe(STARTUP_SCREEN_FALLBACK_GROUND.dark["--ink-2"]);
  });

  it("offers no pair once the person has chosen for themselves", () => {
    expect(groundPair(paper)).toBeUndefined();
    expect(groundPair(following)).toBeDefined();
    expect(groundPair(undefined)).toBeDefined();
  });
});
