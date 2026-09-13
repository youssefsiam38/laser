import { spawn } from "node:child_process";
import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DirectoryEntry, DirectoryExplorerOptions, DirectoryListing } from "@lasercode/protocol";

// Same generated/dependency-directory exclusions as the non-git project file walk.
const WALK_SKIP = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache", ".gradle", ".idea", "vendor"]);
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Git owns ignore rules (including global excludes and tracked-file exceptions). */
function ignored(root: string, paths: string[]): Promise<Set<string> | undefined> {
  return new Promise((done) => {
    const child = spawn("git", ["-C", root, "check-ignore", "--stdin", "-z"], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) child.kill(); else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); done(undefined); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 || code === 1 ? new Set(Buffer.concat(chunks).toString().split("\0")) : undefined);
    });
    child.stdin.end(paths.join("\0") + "\0");
  });
}

/** Opt-in only: the legacy project chooser remains unchanged. No worker is opened. */
export async function browseExplorer(path: string | undefined, options: DirectoryExplorerOptions): Promise<DirectoryListing> {
  const root = resolve(options.root);
  const target = resolve(root, path ?? ".");
  const base = { path: target, home: homedir(), ...(target !== root ? { parent: resolve(target, "..") } : {}) };
  const failure = (error: string): DirectoryListing => ({ ...base, entries: [], truncated: false, error });
  try {
    if (!isAbsolute(options.root) || !inside(root, target)) return failure("Choose a path inside this project.");
    const realRoot = await realpath(root);
    if (!inside(realRoot, await realpath(target))) return failure("Choose a path inside this project.");
    const entries: DirectoryEntry[] = [];
    const directory = await opendir(target);
    for await (const entry of directory) {
      if (!entry.name.toLocaleLowerCase().startsWith(options.prefix.toLocaleLowerCase()) || entry.name === ".git") continue;
      const full = join(target, entry.name);
      let kind: "directory" | "file";
      if (entry.isSymbolicLink()) {
        try {
          if (!inside(realRoot, await realpath(full))) continue;
          const info = await stat(full);
          if (!info.isDirectory() && !info.isFile()) continue;
          kind = info.isDirectory() ? "directory" : "file";
        } catch { continue; }
      } else if (entry.isDirectory()) kind = "directory";
      else if (entry.isFile()) kind = "file";
      else continue;
      entries.push({ name: entry.name, path: full, project: false, kind });
    }
    const excluded = await ignored(root, entries.map((entry) => entry.path));
    const matches = entries.filter((entry) => excluded ? !excluded.has(entry.path) : !WALK_SKIP.has(entry.name));
    matches.sort((a, b) => Number(a.name.startsWith(".")) - Number(b.name.startsWith("."))
      || Number(a.kind === "file") - Number(b.kind === "file")
      || a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
      || a.name.localeCompare(b.name, "en"));
    let commonPrefix = matches[0]?.name ?? "";
    for (const entry of matches) {
      while (!entry.name.startsWith(commonPrefix)) commonPrefix = commonPrefix.slice(0, -1);
    }
    const start = options.offset ?? 0;
    const end = start + Math.max(1, Math.min(100, options.limit ?? 80));
    return { ...base, entries: matches.slice(start, end), truncated: end < matches.length, commonPrefix,
      ...(end < matches.length ? { nextOffset: end } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "ENOENT" || code === "ENOTDIR" ? "This folder no longer exists. Check the path."
      : code === "EACCES" || code === "EPERM" ? "You do not have permission to open this folder."
      : "Couldn’t read this folder. Try again.");
  }
}
