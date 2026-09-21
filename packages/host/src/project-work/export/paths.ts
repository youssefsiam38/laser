/**
 * Where an import reads and an export writes, and nothing else (M21-T21).
 *
 * Every path that reaches the filesystem from the interop methods comes
 * through here, for one reason: a project-relative path a caller supplied is
 * only ever resolved **inside the project it named**. The wire schema already
 * refuses absolute paths, drive letters and `..` segments; this module resolves
 * what survived that against the project's own directory and refuses anything
 * that still lands outside it, including through a symlink that points away.
 *
 * It also owns the two file operations the export needs — an atomic write and
 * a bounded read — so the rest of the interop code never touches `node:fs`
 * directly and cannot invent a third way of writing a project's files.
 *
 * There is no host-side project-config writer to borrow: `<project>/.<name>/`
 * is written by the worker's settings and design modules, and a project-work
 * method may not start a worker (D-331). So the export writes through this
 * file, with the same rules those writers follow — create the directory, write
 * a temporary file beside the target, rename it into place — and never a
 * partially written document.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_DIR_NAME, WORK_EXPORT_DIR } from "@lasercode/protocol";

import { ProjectWorkNotFoundError, ProjectWorkRefusedError } from "../errors.js";
import type { ProjectWorkStore } from "../store.js";

/** The default export root, project-relative: `.<name>/work`. */
export const DEFAULT_EXPORT_ROOT = `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`;

/** The directory a project is open at right now. */
export function projectDirectory(store: ProjectWorkStore, projectId: string): string {
  const paths = store.projectPaths(projectId);
  const root = paths[0];
  if (!root) {
    throw new ProjectWorkNotFoundError("This project is not open at a folder on this machine, so there is nothing to import from or export to.");
  }
  return resolve(root);
}

/** A project-relative path, in the one form everything else compares. */
export function normaliseRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolve a project-relative path inside the project, or refuse.
 *
 * The refusal is deliberately the same sentence whether the path was absolute,
 * climbed out with `..`, or resolved out through a link: a caller learns that
 * it may not leave the project, and nothing about what is outside it.
 */
export function insideProject(projectRoot: string, path: string): string {
  const cleaned = normaliseRelative(path);
  if (cleaned === "" || isAbsolute(cleaned)) {
    throw new ProjectWorkRefusedError("Name a folder inside this project.");
  }
  const target = resolve(projectRoot, cleaned);
  const within = relative(projectRoot, target);
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new ProjectWorkRefusedError("Name a folder inside this project.");
  }
  return target;
}

/** What is at a path: a file, a directory, or nothing. Never a throw. */
export function kindOf(path: string): "file" | "directory" | "none" {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "none";
  } catch {
    return "none";
  }
}

export interface WalkedFile {
  /** Path relative to the root that was walked, with `/` separators. */
  path: string;
  absolute: string;
  bytes: number;
}

/** Directories no adapter ever descends into. Build output and history. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "out", ".next", "coverage", ".turbo", ".cache", ".worktrees"]);

/**
 * Every file under a root, bounded and in a stable order.
 *
 * Sorted by path so an adapter's proposals — and therefore the preview digest
 * that fences them — do not depend on the order a filesystem happened to hand
 * entries back in.
 */
export function walkFiles(root: string, options: { max: number; extensions?: readonly string[] }): { files: WalkedFile[]; truncated: boolean } {
  const files: WalkedFile[] = [];
  let truncated = false;
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (truncated || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (truncated) return;
      // A symlink is neither followed nor read: an adapter reads the files a
      // person can see in their own project, not wherever a link points.
      if (entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      const childPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        visit(child, childPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (options.extensions && !options.extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) continue;
      if (files.length >= options.max) {
        truncated = true;
        return;
      }
      let bytes = 0;
      try {
        bytes = statSync(child).size;
      } catch {
        continue;
      }
      files.push({ path: childPath, absolute: child, bytes });
    }
  };
  visit(root, "", 0);
  return { files, truncated };
}

/** Read one text file, refusing anything above the ceiling rather than loading it. */
export function readTextFile(path: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Write one file, atomically: the temporary file is written and renamed, so a
 * reader sees the previous document or the new one and never half of either.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const directory = path.slice(0, path.lastIndexOf(sep));
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Remove one file. A file that is already gone is not an error. */
export function removeFile(path: string): void {
  rmSync(path, { force: true });
}
