/**
 * The file set host grounding reads, and nothing else (M21-T12, D-353).
 *
 * Grounding a host page is the same kind of work as building the index: a
 * bounded walk that opens text files, hashes them and reads them as text. It
 * imports no project module, resolves no bundler alias by running one, and
 * never asks a framework where a route lives — it reads the conventions off
 * the paths.
 *
 * Tests hand it a literal map; the worker hands it a scan of the project.
 */
import { digestOf, type Gap } from "../index/facts.js";
import { scanProject, type ScanBudget, type ScanResult } from "../index/scan.js";

/** Every file grounding may look at, and a way to read the ones it opened. */
export interface HostFiles {
  /** Project-relative POSIX paths, including assets it will never open. */
  readonly paths: readonly string[];
  /** The text of a file the walk opened; undefined for an asset or a miss. */
  read(path: string): string | undefined;
  has(path: string): boolean;
}

/** A file set from literal texts, plus paths (images, say) with no text. */
export function hostFilesFromTexts(texts: ReadonlyMap<string, string> | Record<string, string>, extraPaths: readonly string[] = []): HostFiles {
  const map = texts instanceof Map ? new Map(texts) : new Map(Object.entries(texts));
  const paths = [...new Set([...map.keys(), ...extraPaths])].sort();
  return {
    paths,
    read: (path) => map.get(path),
    has: (path) => map.has(path) || extraPaths.includes(path),
  };
}

/** A file set from one of the index's scans, so a project is walked once. */
export function hostFilesFromScan(scan: ScanResult): HostFiles {
  const paths = scan.files.map((file) => file.path);
  return {
    paths,
    read: (path) => scan.texts.get(path),
    has: (path) => scan.texts.has(path) || paths.includes(path),
  };
}

export interface HostScanOptions {
  /** The app root inside the project, when a repository holds several apps. */
  appRoot?: string;
  budget?: Partial<ScanBudget>;
  signal?: AbortSignal;
}

/** Walk a project once, for grounding. Bounded by the index's own budget. */
export function scanHostFiles(projectCwd: string, options: HostScanOptions = {}): { files: HostFiles; gaps: Gap[]; truncated: boolean } {
  const root = options.appRoot === undefined || options.appRoot === "" || options.appRoot === "." ? projectCwd : `${projectCwd}/${options.appRoot}`;
  const scan = scanProject(root, {
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  return { files: hostFilesFromScan(scan), gaps: scan.gaps, truncated: scan.truncated };
}

/** The first of these paths the file set has. */
export function pickExisting(files: HostFiles, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    const normalised = normalisePath(candidate);
    if (normalised !== "" && files.has(normalised)) return normalised;
  }
  return undefined;
}

/** `./a/../b/c.html` → `b/c.html`; always POSIX, never absolute, never `..`. */
export function normalisePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function dirnameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function basenameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/** Join two project-relative pieces, normalised. */
export function joinPath(base: string, relative: string): string {
  return normalisePath(base === "" ? relative : `${base}/${relative}`);
}

/** The digest a text hash is made of. One implementation, one algorithm. */
export const hashText = digestOf;
