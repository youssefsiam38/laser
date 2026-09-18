import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { setImmediate as yieldHost } from "node:timers/promises";
import type { ExplorerEntry, DirectoryExplorerOptions, ExplorerListing } from "@lasercode/protocol";
import { expandHomePath } from "./home-path.js";

const names = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const ties = new Intl.Collator("en");
const compare = (a: ExplorerEntry, b: ExplorerEntry) => Number(a.name.startsWith(".")) - Number(b.name.startsWith("."))
  || Number(a.kind === "file") - Number(b.kind === "file") || names.compare(a.name, b.name) || ties.compare(a.name, b.name);
const CHUNK = 512;
const MERGE_SLICE = 1024;

/** Bounded native sorts, followed by stable cooperative merges. No result ceiling. */
async function sortEntries(entries: ExplorerEntry[]): Promise<ExplorerEntry[]> {
  for (let start = 0; start < entries.length; start += CHUNK) {
    const chunk = entries.slice(start, start + CHUNK).sort(compare);
    for (let i = 0; i < chunk.length; i++) entries[start + i] = chunk[i]!;
    await yieldHost();
  }
  let source = entries;
  let target = new Array<ExplorerEntry>(entries.length);
  for (let width = CHUNK; width < entries.length; width *= 2) {
    let budget = MERGE_SLICE;
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length), end = Math.min(start + width * 2, source.length);
      let left = start, right = middle;
      for (let out = start; out < end; out++) {
        target[out] = right >= end || (left < middle && compare(source[left]!, source[right]!) <= 0) ? source[left++]! : source[right++]!;
        if (--budget === 0) { await yieldHost(); budget = MERGE_SLICE; }
      }
    }
    [source, target] = [target, source];
    await yieldHost();
  }
  return source;
}

type Scan = { entries: ExplorerEntry[]; commonPrefix: string };
// One active explorer scan/sort per host. Identical queued/in-flight path+prefix
// requests share work (including pagination). No cache or cancellation protocol.
const pending = new Map<string, Promise<Scan>>();
let queue: Promise<void> = Promise.resolve();
function scan(target: string, prefix: string): Promise<Scan> {
  const key = JSON.stringify([target, prefix]);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = queue.then(async () => {
    const entries: ExplorerEntry[] = [];
    let commonPrefix = "", scanned = 0;
    const directory = await opendir(target);
    for await (const entry of directory) {
      if (++scanned % 256 === 0) await yieldHost();
      if (!entry.name.toLocaleLowerCase().startsWith(prefix)) continue;
      const full = join(target, entry.name);
      let kind: ExplorerEntry["kind"];
      if (entry.isSymbolicLink()) {
        try {
          const info = await stat(full);
          if (!info.isDirectory() && !info.isFile()) continue;
          kind = info.isDirectory() ? "directory" : "file";
        } catch { continue; }
      } else if (entry.isDirectory()) kind = "directory";
      else if (entry.isFile()) kind = "file";
      else continue;
      if (!entries.length) commonPrefix = entry.name;
      else while (!entry.name.startsWith(commonPrefix)) commonPrefix = commonPrefix.slice(0, -1);
      entries.push({ name: entry.name, path: full, project: false, kind });
    }
    return { entries: await sortEntries(entries), commonPrefix };
  });
  pending.set(key, work);
  queue = work.then(() => { pending.delete(key); }, () => { pending.delete(key); });
  return work;
}

const displayPath = (path: string): string => path.replaceAll("\\", "/");
const nativeSeparators = (path: string): string => path.replace(/[\\/]/gu, sep);

/** Resolve the spellings people paste into the picker; the renderer never guesses host paths. */
export function resolveExplorerPath(path: string | undefined, cwd: string, home = homedir()): string {
  const spelling = nativeSeparators(expandHomePath(path ?? ".", home));
  return resolve(nativeSeparators(cwd), spelling);
}

/** Immediate metadata only: no recursive traversal, file reads, or worker. */
export async function browseExplorer(path: string | undefined, options: DirectoryExplorerOptions, accountHome = homedir()): Promise<ExplorerListing> {
  const cwd = resolve(nativeSeparators(options.cwd));
  const home = resolve(nativeSeparators(accountHome));
  const target = resolveExplorerPath(path, cwd, home);
  // The whole filesystem is browsable (D-300): the picker lists names only,
  // and the agent it feeds can already read anything the person can.
  const parent = resolve(target, "..");
  const base = { path: displayPath(target), home: displayPath(home), ...(target !== parent ? { parent: displayPath(parent) } : {}) };
  const failure = (error: string, errorKind?: "refusal"): ExplorerListing => ({ ...base, entries: [], commonPrefix: "", truncated: false, error, ...(errorKind ? { errorKind } : {}) });
  try {
    if (!isAbsolute(nativeSeparators(options.cwd))) return failure("Choose a conversation directory before browsing.");
    const { entries, commonPrefix } = await scan(target, options.prefix.toLocaleLowerCase());
    const start = options.offset ?? 0;
    const end = start + Math.max(1, Math.min(100, options.limit ?? 80));
    const page = entries.slice(start, end).map(entry => ({ ...entry, path: displayPath(entry.path) }));
    return { ...base, entries: page, truncated: end < entries.length, commonPrefix,
      ...(end < entries.length ? { nextOffset: end } : {}) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return failure(code === "ENOENT" || code === "ENOTDIR" ? "This folder no longer exists. Check the path."
      : code === "EACCES" || code === "EPERM" ? "You do not have permission to open this folder."
      : "Couldn’t read this folder. Try again.");
  }
}
