import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { PRODUCT_NAME } from "@lasercode/protocol";
import { DESKTOP_ARGUMENT_PREFIX, DESKTOP_BRIDGE } from "../src/api.js";

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

/** No launch argument at all, then the two answers the main process can give
 * about this platform's text editor. */
const chrome = { controls: "custom", height: 44, insetLeft: 0, insetRight: 0 };
const bootstraps = [
  null,
  { version: "0.0.0-probe", platform: process.platform, chrome, sourceEditor: true },
  { version: "0.0.0-probe", platform: process.platform, chrome, sourceEditor: false },
];

describe.runIf(runnable)("the bridge, in a real window", () => {
  it(`exposes window.${DESKTOP_BRIDGE} with no preload error`, () => {
    const userData = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-bridge-`));
    const script = join(userData, "probe.cjs");
    writeFileSync(
      script,
      `const { app, BrowserWindow } = require("electron");
       app.disableHardwareAcceleration();
       const errors = [];
       const bootstraps = ${JSON.stringify(bootstraps)};
       app.whenReady().then(async () => {
         const shapes = [];
         for (const bootstrap of bootstraps) {
           const w = new BrowserWindow({
             show: false,
             webPreferences: {
               preload: ${JSON.stringify(preload)},
               sandbox: true,
               contextIsolation: true,
               nodeIntegration: false,
               offscreen: true,
               additionalArguments: bootstrap
                 ? [${JSON.stringify(`${DESKTOP_ARGUMENT_PREFIX}env=`)} + encodeURIComponent(JSON.stringify(bootstrap))]
                 : [],
             },
           });
           w.webContents.on("preload-error", (_e, path, error) => errors.push(String(error && error.message)));
           w.webContents.on("console-message", (e) => {
             const text = typeof e === "string" ? e : (e && e.message) || "";
             if (/preload/i.test(text)) errors.push(text);
           });
           await w.loadURL("data:text/html,<p>probe");
           shapes.push(await w.webContents.executeJavaScript(
             "(() => { const b = window[" + ${JSON.stringify(JSON.stringify(DESKTOP_BRIDGE))} + "]; return b ? Object.keys(b).sort() : null; })()",
           ));
         }
         process.stdout.write("RESULT" + JSON.stringify({ shapes, errors }));
         app.exit(0);
       });`,
    );
    try {
      // This probes the preload, not Chromium's process sandbox. A clean GitHub
      // runner cannot make Electron's downloaded chrome-sandbox root-owned
      // mode 4755, so run this one throwaway hidden process without it.
      const output = execFileSync(electronBin, [script, "--no-sandbox", `--user-data-dir=${userData}`], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
      });
      const result = JSON.parse(output.slice(output.lastIndexOf("RESULT") + "RESULT".length)) as {
        shapes: (string[] | null)[];
        errors: string[];
      };
      const [plain, editor, noEditor] = result.shapes;
      expect(result.errors, "the preload reported an error").toEqual([]);
      expect(plain, `window.${DESKTOP_BRIDGE} was not exposed`).not.toBeNull();
      // The surfaces the renderer depends on. A bridge missing one of these is
      // a window where some control silently does nothing.
      expect(plain).toEqual(expect.arrayContaining(["host", "window", "identity", "updates", "microphone", "openSourceFile"]));
      // A platform with no text editor to open must not carry the function the
      // UI reads as "this window can open files": the button has to disappear,
      // not fail with an explanation that was never true (M16-T49 #20).
      expect(editor).toContain("openSourceFile");
      expect(noEditor).not.toContain("openSourceFile");
      expect(noEditor).toEqual(expect.arrayContaining(["host", "window", "identity", "updates", "microphone"]));
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  }, 90_000);
});
