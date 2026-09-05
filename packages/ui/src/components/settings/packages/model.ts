/**
 * Pure logic behind Settings → Extensions (M10-T5): what to call a package on
 * screen, what a progress event means in words, and how to filter the two
 * lists. Nothing here says "npm" or shows a path; those belong to the
 * diagnostics disclosure alone.
 */
import type { PackageCatalogEntry, PackageEntry, PackageProgress } from "@piorbit/protocol";

/** `npm:@scope/name@1.2.3` → `@scope/name`; a git URL → its last path segment; a path → its last segment. */
export function displayName(entry: Pick<PackageEntry, "source" | "name">): string {
  if (entry.name) return entry.name;
  const source = entry.source.trim();
  if (source.startsWith("npm:")) {
    const spec = source.slice(4);
    const at = spec.lastIndexOf("@");
    return at > 0 ? spec.slice(0, at) : spec;
  }
  const cleaned = source.replace(/\.git$/, "").replace(/[#@][^/]*$/, "").replace(/\/+$/, "");
  const segment = cleaned.split(/[\\/]/).pop();
  return segment && segment.length > 0 ? segment : source;
}

/** Where a package came from, in a word a person recognises. */
export function originLabel(entry: Pick<PackageEntry, "source" | "type">): "registry" | "git" | "folder" {
  if (entry.type === "npm") return "registry";
  if (entry.type === "git") return "git";
  const source = entry.source.trim();
  if (source.startsWith("npm:")) return "registry";
  if (/^(https?:\/\/|git\+|git@|ssh:\/\/|github:|gitlab:|bitbucket:)/i.test(source) || source.endsWith(".git")) return "git";
  return "folder";
}

/** The version to print for a row: what is on disk, else what the source pins. */
export function versionLabel(entry: Pick<PackageEntry, "version" | "pinnedVersion">): string | undefined {
  return entry.version ?? entry.pinnedVersion;
}

export type ProgressPhase = { label: string; detail?: string | undefined; tone: "working" | "done" | "failed" };

const ACTION_WORDS: Record<PackageProgress["action"], { working: string; done: string }> = {
  install: { working: "Installing", done: "Installed" },
  remove: { working: "Removing", done: "Removed" },
  update: { working: "Updating", done: "Updated" },
  clone: { working: "Fetching", done: "Fetched" },
  pull: { working: "Fetching", done: "Fetched" },
};

/**
 * One progress event → one line. The agent's own messages carry the source
 * string and the package manager's chatter, so they are kept only as the
 * detail, and only when they add a fact the label does not already state.
 */
export function describeProgress(event: PackageProgress): ProgressPhase {
  const name = displayName({ source: event.source });
  const words = ACTION_WORDS[event.action];
  if (event.type === "error") {
    return { label: `Could not ${event.action} ${name}`, detail: cleanDetail(event.message, name), tone: "failed" };
  }
  if (event.type === "complete") {
    return { label: `${words.done} ${name}`, tone: "done" };
  }
  return { label: `${words.working} ${name}…`, detail: cleanDetail(event.message, name), tone: "working" };
}

/** Drop the parts of an agent message that repeat the label or leak tooling. */
function cleanDetail(message: string | undefined, name: string): string | undefined {
  if (!message) return undefined;
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  const trimmed = firstLine
    .replace(/^(Installing|Removing|Updating|Cloning|Pulling|Could not [a-z]+)\s+\S+\.{0,3}\s*/i, "")
    .replace(/\bnpm(?:\s+(?:error|ERR!|warn))?\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (trimmed === "" || trimmed.toLowerCase() === name.toLowerCase()) return undefined;
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

export function filterInstalled(entries: readonly PackageEntry[], query: string): PackageEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter((entry) => `${displayName(entry)} ${entry.source}`.toLowerCase().includes(needle));
}

export function filterCatalog(entries: readonly PackageCatalogEntry[], query: string): PackageCatalogEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter((entry) =>
    `${entry.name} ${entry.description ?? ""} ${(entry.keywords ?? []).join(" ")}`.toLowerCase().includes(needle),
  );
}

/** Registry search is debounced; anything shorter is answered from the curated list. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 350;

/** Every install/update/remove the screen can be busy with, so buttons can name their own state. */
export type BusyKey = `install:${string}` | `update:${string}` | `remove:${string}` | "update:all" | "check";
