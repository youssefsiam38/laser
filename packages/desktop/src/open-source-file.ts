import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const failure = { opened: false, reason: "Couldn’t open this source file. Check that it still exists and that your system has a default text editor." };
/** Said only where the app has no way to open an editor at all — never the
 * sentence above, which would blame the person's setup for something this
 * system was never asked to do. The window hides the button here anyway. */
const unavailable = "Opening files in an editor isn’t available on this system. Copy the path and open the file yourself.";
const execute = promisify(execFile);
type Run = typeof execute;
/**
 * Start a program that *is* the editor and let it live: resolved once the
 * process exists, never waiting for it to exit. `run` above is for launchers
 * (`gio launch`, `open -t`, `reg query`) that return at once; awaiting an
 * editor through it would kill the editor at the timeout and call that a
 * failure (0.6.3 review B1).
 */
export type Launch = (executable: string, args: readonly string[]) => Promise<void>;
const detached: Launch = (executable, args) => new Promise((resolve, reject) => {
  const child = spawn(executable, [...args], { detached: true, stdio: "ignore", windowsHide: false });
  child.once("error", reject);
  child.once("spawn", () => { child.unref(); resolve(); });
});
const spawnOptions = { timeout: 5000, encoding: "utf8" } as const;

/**
 * Where a text-editor path exists at all. The main process tells the window at
 * startup (`WindowBootstrap.sourceEditor`), so a platform this file cannot open
 * a file on never draws an "Open in editor" button: the UI offers the path to
 * copy instead, exactly as it does for the phone and the browser.
 */
export function textEditorSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin" || platform === "win32";
}

/** Select the OS text editor, not the file's MIME handler (HTML → browser,
 * scripts → execution). Desktop entries belong to the user's OS configuration.
 * gio expands their Exec field; never parse it ourselves or invoke a shell. */
export async function openInTextEditor(path: string, run: Run = execute, platform: NodeJS.Platform = process.platform, launch: Launch = detached): Promise<string> {
  try {
    if (platform === "linux") return await openWithFreedesktop(path, run);
    if (platform === "darwin") return await openWithMacOpen(path, run);
    if (platform === "win32") return await openWithWindowsEditor(path, run, launch);
    return unavailable;
  } catch { return failure.reason; }
}

async function openWithFreedesktop(path: string, run: Run): Promise<string> {
  const { stdout } = await run("xdg-mime", ["query", "default", "text/plain"], spawnOptions);
  const id = stdout.trim();
  if (!/^[\w.-]+\.desktop$/.test(id) || id.startsWith(".")) return failure.reason;
  const roots = [process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")].filter(isAbsolute);
  for (const root of roots) {
    const entry = join(root, "applications", id);
    if (!(await stat(entry).catch(() => undefined))?.isFile()) continue;
    await run("gio", ["launch", entry, pathToFileURL(path).href], spawnOptions);
    return "";
  }
  return failure.reason;
}

/** `open -t` is macOS's "open as text": the editor registered for plain text,
 * whatever the file's own extension would have launched. The file is an
 * argument to `open`, never a command, and never reaches a shell. */
async function openWithMacOpen(path: string, run: Run): Promise<string> {
  await run("open", ["-t", path], spawnOptions);
  return "";
}

/**
 * Windows has no "open as text" verb, so ask the registry for the program the
 * person's plain-text association points at and run *that* with the file as an
 * argument. Handing the file to the shell instead would pick the handler for
 * its own extension — a browser for `.html`, an interpreter for `.ps1` — which
 * is the one thing this feature may never do. Notepad ships with every Windows
 * and is the fallback when the registration is missing or unusable.
 */
async function openWithWindowsEditor(path: string, run: Run, launch: Launch): Promise<string> {
  const registered = await windowsRegisteredEditor(run);
  if (registered) {
    try {
      await launch(registered, [path]);
      return "";
    } catch { /* An editor that will not start is not a reason to give up. */ }
  }
  const root = (process.env["SystemRoot"] || "C:\\Windows").replace(/[\\/]+$/, "");
  await launch(`${root}\\system32\\notepad.exe`, [path]);
  return "";
}

/** `HKEY_CLASSES_ROOT\txtfile\shell\open\command`, read as data: the executable
 * only, never the `%1` placeholders or switches around it, and never a shell. */
async function windowsRegisteredEditor(run: Run): Promise<string | undefined> {
  try {
    const { stdout } = await run("reg", ["query", "HKCR\\txtfile\\shell\\open\\command", "/ve"], spawnOptions);
    // Match the value's type rather than its name: the default value prints
    // under a localised name on a localised Windows.
    const command = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(stdout)?.[1];
    if (!command) return undefined;
    const expanded = command.replace(/%([^%\s]+)%/g, (whole, name: string) =>
      Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? whole);
    const executable = /^\s*"([^"]+)"/.exec(expanded)?.[1] ?? /^\s*(.*?\.exe)(?:\s|$)/i.exec(expanded)?.[1];
    if (!executable || !/^([a-z]:[\\/]|\\\\)/i.test(executable) || !executable.toLowerCase().endsWith(".exe")) return undefined;
    return executable;
  } catch { return undefined; }
}

/** Existing text only, including after symlink resolution. No URL execution. */
export async function openSourceFile(path: unknown, openPath: (path: string) => Promise<string> = openInTextEditor): Promise<{ opened: boolean; reason?: string }> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return failure;
  try {
    const resolved = await realpath(path);
    if ([".desktop", ".exe", ".lnk", ".app"].includes(extname(resolved).toLowerCase()) || !(await stat(resolved)).isFile()) return failure;
    const handle = await open(resolved, "r");
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) return failure;
    } finally { await handle.close(); }
    const reason = await openPath(resolved);
    return reason ? { opened: false, reason } : { opened: true };
  } catch { return failure; }
}
