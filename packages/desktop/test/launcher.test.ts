/**
 * One name, two programs (M10-T1).
 *
 * `~/.local/bin/piorbit` is what the installer puts on a person's PATH, and it
 * is the launcher script — so it is also what answers `piorbit doctor` typed in
 * a terminal. Getting the split wrong is invisible in a build and obvious to a
 * person: either a window opens when they asked for a command, or a Chromium
 * flag that Electron passes to itself on relaunch is handed to the CLI, which
 * refuses it and the app never comes back.
 *
 * The dispatch table is nine lines of shell with no other way to check it, so
 * it is checked here against stubs that only record which one ran.
 */
import { BINARY_NAME, ENV, PRODUCT_NAME, REAL_BINARY_NAME, URL_SCHEME_PREFIX } from "@lasercode/protocol";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "linux", "generated", "launcher.sh");
const root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-launcher-`));

afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A fake install: the launcher, the renamed Electron binary beside it, a
 * `node` standing in for the bundled runtime, and a CLI entry that exists only
 * so the launcher's existence check passes. Each stub writes what it was called
 * with to one file.
 */
function install(): { dir: string; log: string } {
  const dir = mkdtempSync(join(root, "app-"));
  const log = join(dir, "called");
  const cliDir = join(dir, "resources", "app.asar.unpacked", "node_modules", "@lasercode", "cli", "dist");
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(join(dir, "resources", "runtime"), { recursive: true });
  writeFileSync(join(cliDir, "main.js"), "// stub\n");

  for (const [name, label] of [
    [join(dir, REAL_BINARY_NAME), "window"],
    [join(dir, "resources", "runtime", "node"), "command"],
  ] as const) {
    writeFileSync(name, `#!/bin/sh\nprintf '${label} %s\\n' "$*" > "${log}"\n`);
    chmodSync(name, 0o755);
  }
  writeFileSync(join(dir, BINARY_NAME), readFileSync(launcher, "utf8"));
  chmodSync(join(dir, BINARY_NAME), 0o755);
  return { dir, log };
}

function run(args: string[], env: Record<string, string> = {}, withAppRun = false): string {
  const { dir, log } = install();
  if (withAppRun) writeFileSync(join(dir, "AppRun"), "#!/usr/bin/env bash\n");
  const result = spawnSync(join(dir, BINARY_NAME), args, {
    encoding: "utf8",
    // No display and no Wayland, so the launcher adds no feature flag and the
    // recorded arguments are only the ones under test.
    env: { PATH: "/usr/bin:/bin", HOME: dir, ...env },
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return readFileSync(log, "utf8").trim();
}

describe("the launcher decides between the window and the command", () => {
  it("opens the window with no arguments", () => {
    expect(run([])).toMatch(/^window/);
  });

  it(`opens the window for a ${URL_SCHEME_PREFIX} link, which is how the desktop hands one over`, () => {
    expect(run([`${URL_SCHEME_PREFIX}session/abc`])).toBe(`window ${URL_SCHEME_PREFIX}session/abc`);
  });

  it("opens the window for Electron's own flags, which it passes to itself on relaunch", () => {
    expect(run(["--dev"])).toBe("window --dev");
    expect(run(["--enable-features=X"])).toBe("window --enable-features=X");
    expect(run(["--disable-gpu-sandbox"])).toMatch(/^window/);
  });

  it("runs the command for an ordinary word, with its arguments intact", () => {
    expect(run(["doctor"])).toMatch(/^command \S+cli\/dist\/main\.js doctor$/);
    expect(run(["sessions", "--json"])).toMatch(/main\.js sessions --json$/);
  });

  it("runs the command for the four flags a person types meaning the command", () => {
    for (const flag of ["--help", "-h", "--version", "-v"]) {
      expect(run([flag])).toMatch(new RegExp(`main\\.js ${flag.replace("-", "\\-")}$`));
    }
  });
});

/**
 * What AppRun hands over.
 *
 * electron-builder's AppRun probes with `unshare -Ur true` and, when that
 * fails — as it does on stock Ubuntu 24.04 — *prepends* `--no-sandbox` to
 * whatever the person typed. Letting it through is a silent sandbox downgrade;
 * deciding window-or-command before dropping it sends `piorbit doctor` to a
 * window.
 *
 * The trap is how you know AppRun ran. A *mounted* AppImage is easy: the
 * AppImage runtime exports APPIMAGE and APPDIR. An *extracted* AppDir is not —
 * AppRun assigns both without `export`, so neither reaches the launcher, and
 * an earlier version of this file set APPDIR itself and therefore proved
 * nothing. install.sh now points at this launcher instead of AppRun, and the
 * launcher's own last resort is the shape of the injection: an AppRun beside
 * it, and --no-sandbox as the first argument.
 */
describe("what AppRun hands over", () => {
  it("drops the --no-sandbox a mounted AppImage's AppRun injected", () => {
    expect(run(["--no-sandbox"], { APPIMAGE: `/tmp/${PRODUCT_NAME}.AppImage`, APPDIR: "/anything" })).toBe("window");
  });

  it("drops it on an extracted AppDir too, where AppRun exports nothing", () => {
    expect(run(["--no-sandbox"], {}, true)).toBe("window");
  });

  it("still runs the command when AppRun put its flag in front of it", () => {
    expect(run(["--no-sandbox", "doctor"], {}, true)).toMatch(/^command \S+main\.js doctor$/);
  });

  it("honours an explicit opt-out rather than second-guessing it", () => {
    expect(run(["--no-sandbox"], { APPDIR: "/anything", [ENV.disableSandbox]: "1" })).toBe("window --no-sandbox");
  });

  it("leaves a person's own --no-sandbox alone when there is no AppRun at all", () => {
    expect(run(["--no-sandbox"])).toBe("window --no-sandbox");
  });

  it("leaves a --no-sandbox that is not in front alone: AppRun always prepends", () => {
    expect(run(["--dev", "--no-sandbox"], {}, true)).toBe("window --dev --no-sandbox");
  });
});
