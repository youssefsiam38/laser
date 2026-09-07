import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const failure = { opened: false, reason: "Couldn’t open this source file. Check that it still exists and that your system has a default text editor." };
const execute = promisify(execFile);

/** Select the OS text editor, not the file's MIME handler (HTML → browser,
 * scripts → execution). Desktop entries belong to the user's OS configuration.
 * gio expands their Exec field; never parse it ourselves or invoke a shell. */
export async function openInTextEditor(path: string, run = execute): Promise<string> {
  try {
    const { stdout } = await run("xdg-mime", ["query", "default", "text/plain"], { timeout: 5000, encoding: "utf8" });
    const id = stdout.trim();
    if (!/^[\w.-]+\.desktop$/.test(id) || id.startsWith(".")) return failure.reason;
    const roots = [process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")].filter(isAbsolute);
    for (const root of roots) {
      const entry = join(root, "applications", id);
      if (!(await stat(entry).catch(() => undefined))?.isFile()) continue;
      await run("gio", ["launch", entry, pathToFileURL(path).href], { timeout: 5000, encoding: "utf8" });
      return "";
    }
    return failure.reason;
  } catch { return failure.reason; }
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
    return await openPath(resolved) ? failure : { opened: true };
  } catch { return failure; }
}
