import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

const failure = { opened: false, reason: "Couldn’t open this source file. Check that it still exists and choose a default application for Markdown files in your system settings." };

/** No shell commands or URLs: only existing Markdown, including after symlink resolution. */
export async function openSourceFile(path: unknown, openPath: (path: string) => Promise<string>): Promise<{ opened: boolean; reason?: string }> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || !markdown(path)) return failure;
  try {
    const resolved = await realpath(path);
    if (!markdown(resolved) || !(await stat(resolved)).isFile()) return failure;
    return await openPath(resolved) ? failure : { opened: true };
  } catch { return failure; }
}

function markdown(path: string): boolean { return [".md", ".mdx", ".markdown"].includes(extname(path).toLowerCase()); }
