/**
 * The file walk the index is built from: bounded, ignore-listed, parse-only.
 *
 * It reads bytes and hashes them. It never follows a symlink out of the
 * project, never opens a file larger than its per-file budget, and stops the
 * moment the build's file or byte budget is spent — recording what it did not
 * look at as a gap rather than pretending the project ends there
 * (`docs/design-phase.md`, "Security, privacy and resources").
 *
 * A large monorepo is indexed **per app root**: the caller passes the root the
 * person chose, and everything outside it is simply not walked.
 */
import { PROJECT_DIR_NAME } from "@lasercode/protocol";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { digestOf, type Gap, type SourceFile } from "./facts.js";

/** Directories no design index has any business reading. */
export const IGNORED_DIRECTORIES: readonly string[] = [
  // The project's own configuration directory, which is where this index is
  // written: an index that indexed itself would grow every time it ran.
  PROJECT_DIR_NAME,
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__",
  ".worktrees",
  "tmp",
  "log",
];

/** Text extensions worth parsing, by family. Anything else is inventory only. */
export const PARSED_EXTENSIONS: readonly string[] = [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
  ".erb",
  ".haml",
  ".slim",
  ".twig",
  ".blade.php",
  ".php",
  ".hbs",
  ".handlebars",
  ".ejs",
  ".liquid",
  ".mdx",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".lock",
];

/** Manifests with no extension. A design index reads these as manifests. */
export const PARSED_FILENAMES: readonly string[] = ["Gemfile", "Podfile", "Brewfile"];

/** Files that are inventory (icons, images, fonts) and are never opened. */
export const ASSET_EXTENSIONS: readonly string[] = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
];

export interface ScanBudget {
  /** How many files may be opened. */
  maxFiles: number;
  /** How many bytes may be read in total. */
  maxBytes: number;
  /** The largest file that is opened at all. A bigger one is a gap. */
  maxFileBytes: number;
  /** How many entries the walk may visit, assets and skipped files included. */
  maxEntries: number;
}

export const DEFAULT_SCAN_BUDGET: ScanBudget = {
  maxFiles: 4_000,
  maxBytes: 48 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxEntries: 40_000,
};

/** One file the walk found. `text` is present only for files it opened. */
export interface ScannedFile {
  path: string;
  bytes: number;
  digest?: string;
  kind: "parsed" | "asset" | "skipped";
}

export interface ScanResult {
  /** Every file the walk saw, in a stable order. */
  files: ScannedFile[];
  gaps: Gap[];
  /** True when a budget stopped the walk before the tree was exhausted. */
  truncated: boolean;
  bytesRead: number;
  /** The text of the files the walk opened, so nothing is read twice. */
  texts: Map<string, string>;
}

export interface ScanOptions {
  budget?: Partial<ScanBudget>;
  /** Stops the walk between files. A stopped walk answers what it has. */
  signal?: AbortSignal;
}

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** The extension family of a path, longest match first (`.blade.php`). */
export function extensionOf(path: string): string {
  const lower = path.toLowerCase();
  for (const extension of PARSED_EXTENSIONS) {
    if (extension.includes(".", 1) && lower.endsWith(extension)) return extension;
  }
  const dot = lower.lastIndexOf(".");
  return dot === -1 ? "" : lower.slice(dot);
}

export function isAssetPath(path: string): boolean {
  return ASSET_EXTENSIONS.includes(extensionOf(path));
}

export function isParsedPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  if (PARSED_FILENAMES.includes(name)) return true;
  return PARSED_EXTENSIONS.includes(extensionOf(path));
}

/**
 * Walk one root and report every file, with a digest for each file small
 * enough to open. Deterministic order: directories and files sorted by name,
 * so two builds of an unchanged tree produce the same list.
 */
export function scanProject(root: string, options: ScanOptions = {}): ScanResult {
  const budget: ScanBudget = { ...DEFAULT_SCAN_BUDGET, ...options.budget };
  const base = resolve(root);
  const files: ScannedFile[] = [];
  const gaps: Gap[] = [];
  const texts = new Map<string, string>();
  let bytesRead = 0;
  let entries = 0;
  let opened = 0;
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch (error) {
      gaps.push({ path: posix(relative(base, directory)) || ".", reason: `this folder could not be read (${reason(error)}).` });
      return;
    }
    for (const name of names) {
      if (truncated) return;
      if (options.signal?.aborted === true) {
        truncated = true;
        return;
      }
      if (++entries > budget.maxEntries) {
        truncated = true;
        gaps.push({ path: posix(relative(base, directory)) || ".", reason: "the walk reached its file-count budget here; the rest of this folder was not indexed." });
        return;
      }
      const full = join(directory, name);
      const rel = posix(relative(base, full));
      let stats;
      try {
        stats = statSync(full);
      } catch (error) {
        gaps.push({ path: rel, reason: `this file could not be read (${reason(error)}).` });
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        if (IGNORED_DIRECTORIES.includes(name)) continue;
        walk(full);
        continue;
      }
      if (!stats.isFile()) continue;
      if (isAssetPath(rel)) {
        files.push({ path: rel, bytes: stats.size, kind: "asset" });
        continue;
      }
      if (!isParsedPath(rel)) {
        files.push({ path: rel, bytes: stats.size, kind: "skipped" });
        continue;
      }
      if (stats.size > budget.maxFileBytes) {
        files.push({ path: rel, bytes: stats.size, kind: "skipped" });
        gaps.push({ path: rel, reason: `this file is ${String(Math.round(stats.size / 1024))} KB, past the size a parse opens; nothing was read from it.` });
        continue;
      }
      if (opened >= budget.maxFiles || bytesRead + stats.size > budget.maxBytes) {
        truncated = true;
        gaps.push({ path: rel, reason: "the build reached its budget before this file; re-index this app root on its own to include it." });
        return;
      }
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch (error) {
        files.push({ path: rel, bytes: stats.size, kind: "skipped" });
        gaps.push({ path: rel, reason: `this file could not be read (${reason(error)}).` });
        continue;
      }
      bytesRead += stats.size;
      opened += 1;
      files.push({ path: rel, bytes: stats.size, digest: digestOf(text), kind: "parsed" });
      texts.set(rel, text);
    }
  };

  walk(base);
  return { files, gaps, truncated, bytesRead, texts };
}

/** Every opened file of a scan, as the parsers want it. */
export function openedFiles(scan: ScanResult): SourceFile[] {
  const files: SourceFile[] = [];
  for (const file of scan.files) {
    if (file.kind !== "parsed" || file.digest === undefined) continue;
    const text = scan.texts.get(file.path);
    if (text === undefined) continue;
    files.push({ path: file.path, digest: file.digest, text, lines: text.split(/\r?\n/), bytes: file.bytes });
  }
  return files;
}

function reason(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "EACCES" || code === "EPERM") return "no permission";
  if (code === "ENOENT") return "it is no longer there";
  return error instanceof Error ? error.message : String(error);
}
