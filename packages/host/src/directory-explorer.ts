import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { DirectoryEntry, DirectoryExplorerOptions, DirectoryListing } from "@lasercode/protocol";

/** Opt-in machine explorer. The OS account is the boundary, as for file previews.
 * Only immediate entry metadata is read; no recursive traversal or file reads.
 * The legacy project chooser remains unchanged. No worker is opened.
 */
export async function browseExplorer(path: string | undefined, options: DirectoryExplorerOptions): Promise<DirectoryListing> {
  const target = resolve(options.cwd, path ?? ".");
  const parent = resolve(target, "..");
  const base = { path: target, home: homedir(), ...(target !== parent ? { parent } : {}) };
  const failure = (error: string): DirectoryListing => ({ ...base, entries: [], truncated: false, error });
  try {
    if (!isAbsolute(options.cwd)) return failure("Choose a conversation directory before browsing.");
    const entries: DirectoryEntry[] = [];
    const directory = await opendir(target);
    for await (const entry of directory) {
      if (!entry.name.toLocaleLowerCase().startsWith(options.prefix.toLocaleLowerCase())) continue;
      const full = join(target, entry.name);
      let kind: "directory" | "file";
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(full);
          if (!info.isDirectory() && !info.isFile()) continue;
          kind = info.isDirectory() ? "directory" : "file";
        } catch { continue; }
      } else if (entry.isDirectory()) kind = "directory";
      else if (entry.isFile()) kind = "file";
      else continue;
      entries.push({ name: entry.name, path: full, project: false, kind });
    }
    entries.sort((a, b) => Number(a.name.startsWith(".")) - Number(b.name.startsWith("."))
      || Number(a.kind === "file") - Number(b.kind === "file")
      || a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
      || a.name.localeCompare(b.name, "en"));
    let commonPrefix = entries[0]?.name ?? "";
    for (const entry of entries) {
      while (!entry.name.startsWith(commonPrefix)) commonPrefix = commonPrefix.slice(0, -1);
    }
    const start = options.offset ?? 0;
    const end = start + Math.max(1, Math.min(100, options.limit ?? 80));
    return { ...base, entries: entries.slice(start, end), truncated: end < entries.length, commonPrefix,
      ...(end < entries.length ? { nextOffset: end } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "ENOENT" || code === "ENOTDIR" ? "This folder no longer exists. Check the path."
      : code === "EACCES" || code === "EPERM" ? "You do not have permission to open this folder."
      : "Couldn’t read this folder. Try again.");
  }
}
