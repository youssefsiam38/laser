import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DESKTOP_BRIDGE } from "../src/api.js";

/**
 * Does the bridge actually arrive in the window?
 *
 * Every other preload test reads source text, and source text is what lied:
 * `require("./ipc.generated.cjs")` was correct TypeScript, compiled cleanly,
 * type-checked, and then failed at load time because a sandboxed preload cannot
 * resolve a relative specifier. Electron's answer to a preload that throws is to
 * load the page anyway — so the app opened, drew, and quietly had no bridge:
 * every control that asks the desktop for something did nothing, with no error
 * anywhere a person would look.
 *
 * The only test that catches that class is one that runs the real binary and
 * looks at the real window. It launches Electron headless-ish (a hidden window,
 * `offscreen` so it needs no display), loads a blank page with the built
 * preload, and asks the page what is on `window`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const electronBin = join(packageRoot, "node_modules", ".bin", "electron");
const preload = join(packageRoot, "dist", "preload.cjs");

const runnable = existsSync(electronBin) && existsSync(preload);

describe.runIf(runnable)("the bridge, in a real window", () => {
  it(`exposes window.${DESKTOP_BRIDGE} with no preload error`, () => {
    const userData = mkdtempSync(join(tmpdir(), "laser-bridge-"));
    const script = join(userData, "probe.cjs");
    writeFileSync(
      script,
      `const { app, BrowserWindow } = require("electron");
       app.disableHardwareAcceleration();
       const errors = [];
       app.whenReady().then(async () => {
         const w = new BrowserWindow({
           show: false,
           webPreferences: {
             preload: ${JSON.stringify(preload)},
             sandbox: true,
             contextIsolation: true,
             nodeIntegration: false,
             offscreen: true,
           },
         });
         w.webContents.on("preload-error", (_e, path, error) => errors.push(String(error && error.message)));
         w.webContents.on("console-message", (e) => {
           const text = typeof e === "string" ? e : (e && e.message) || "";
           if (/preload/i.test(text)) errors.push(text);
         });
         await w.loadURL("data:text/html,<p>probe");
         const shape = await w.webContents.executeJavaScript(
           "(() => { const b = window[" + ${JSON.stringify(JSON.stringify(DESKTOP_BRIDGE))} + "]; return b ? Object.keys(b).sort() : null; })()",
         );
         process.stdout.write("RESULT" + JSON.stringify({ shape, errors }));
         app.exit(0);
       });`,
    );
    try {
      const output = execFileSync(electronBin, [script, `--user-data-dir=${userData}`], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      });
      const result = JSON.parse(output.slice(output.lastIndexOf("RESULT") + "RESULT".length)) as {
        shape: string[] | null;
        errors: string[];
      };
      expect(result.errors, "the preload reported an error").toEqual([]);
      expect(result.shape, `window.${DESKTOP_BRIDGE} was not exposed`).not.toBeNull();
      // The surfaces the renderer depends on. A bridge missing one of these is
      // a window where some control silently does nothing.
      expect(result.shape).toEqual(expect.arrayContaining(["host", "window", "identity", "updates", "microphone"]));
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }, 90_000);
});
