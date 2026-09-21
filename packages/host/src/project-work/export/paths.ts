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
 * Containment is decided against the filesystem, not against strings, in the
 * same shape the host already uses for a background command's log file
 * (`tasks/register.ts#isInsideRoot`):
 *
 * - the project's directory is resolved once, through `realpath`; a project
 *   folder that is not on this machine right now is a refusal, never a
 *   lexical guess;
 * - the deepest part of the target that already exists is resolved through
 *   `realpath` too, so a link **anywhere above** the target that leads out of
 *   the project is refused — and one that stays inside it is the person's own
 *   folder layout, which is allowed;
 * - the final component is never followed: a read opens with `O_NOFOLLOW`, a
 *   write goes to a fresh exclusive temporary file and is renamed over the
 *   name (rename replaces a link, it does not write through it), and a delete
 *   unlinks a regular file only.
 *
 * This is containment, not atomicity. Node has no `openat`/`mkdirat`, so
 * between resolving a directory and using it another process **with write
 * access to this project's folder** could replace an ancestor. The window is
 * bounded by re-resolving immediately before each write and by refusing rather
 * than following, and the project folder is one the person trusted; it is not
 * a race-proof sandbox, and nothing here should be read as claiming that.
 *
 * Two areas are refused outright, for reads as much as for writes: a
 * repository's own `.git` storage, and this project's settings directory apart
 * from the export area inside it. An export writes documents; it may never
 * land on the files the app itself reads back as configuration.
 *
 * There is no host-side project-config writer to borrow: `<project>/.<name>/`
 * is written by the worker's settings and design modules, and a project-work
 * method may not start a worker (D-331). So the export writes through this
 * file, with the same rules those writers follow — create the directory, write
 * a temporary file beside the target, rename it into place — and never a
 * partially written document.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PROJECT_DIR_NAME, WORK_EXPORT_DIR } from "@lasercode/protocol";

import { ProjectWorkNotFoundError, ProjectWorkRefusedError } from "../errors.js";
import type { ProjectWorkStore } from "../store.js";

/** The default export root, project-relative: `.<name>/work`. */
export const DEFAULT_EXPORT_ROOT = `${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR}`;

/**
 * The refusal for a path that may not be used, whatever the reason.
 *
 * Deliberately the same sentence whether the path was absolute, climbed out
 * with `..`, or resolved out through a link: a caller learns that it may not
 * leave the project, and nothing about what is outside it.
 */
const OUTSIDE = "Name a folder inside this project.";
const THROUGH_A_LINK = "That path leads out of this project through a link, so nothing was read or written. Name a folder that is really inside this project.";

/** `<root>-2`, `<root>-3`: the revision roots an export may write beside itself. */
const EXPORT_REVISION_ROOT = new RegExp(`^${WORK_EXPORT_DIR}-\\d+$`);

/** The directory a project is open at right now, resolved through the filesystem. */
export function projectDirectory(store: ProjectWorkStore, projectId: string): string {
  const paths = store.projectPaths(projectId);
  const root = paths[0];
  if (!root) {
    throw new ProjectWorkNotFoundError("This project is not open at a folder on this machine, so there is nothing to import from or export to.");
  }
  try {
    return realpathSync(resolve(root));
  } catch {
    // Fail closed: without a resolved root there is no containment to decide,
    // so nothing is read or written on a lexical guess.
    throw new ProjectWorkNotFoundError(
      "This project's folder is not on this machine right now, so there is nothing to import from or export to. Open the project where its files are, then try again.",
    );
  }
}

/** A project-relative path, in the one form everything else compares. */
export function normaliseRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Resolve a project-relative path inside the project, or refuse.
 *
 * `projectRoot` must be the resolved project directory (`projectDirectory`).
 */
export function insideProject(projectRoot: string, path: string): string {
  return insideProjectAt(projectRoot, projectRoot, path);
}

/**
 * Resolve a path inside an already-contained root, still inside the project.
 *
 * The export root, the import root and an export's own file list are resolved
 * relative to a root that was itself checked; the project directory stays the
 * authority, so the forbidden areas and the link rules are decided once,
 * against the project, wherever the caller started from.
 */
export function insideProjectAt(projectRoot: string, base: string, path: string): string {
  const cleaned = normaliseRelative(path);
  if (cleaned === "" || isAbsolute(cleaned)) throw new ProjectWorkRefusedError(OUTSIDE);
  const target = resolve(base, cleaned);
  refuseOutside(base, target);
  refuseOutside(projectRoot, target);
  refuseForbidden(relative(projectRoot, target));

  // What the filesystem says, rather than what the string says.
  const real = realTarget(target);
  refuseOutside(projectRoot, real);
  refuseForbidden(relative(projectRoot, real));
  if (isLink(target)) throw new ProjectWorkRefusedError(THROUGH_A_LINK);
  return target;
}

/** A lexical containment check, used on both the written and the real path. */
function refuseOutside(root: string, target: string): void {
  const within = relative(root, target);
  if (within.startsWith("..") || isAbsolute(within)) throw new ProjectWorkRefusedError(OUTSIDE);
}

/**
 * The path the filesystem would really use: the deepest existing ancestor
 * resolved through `realpath`, plus the part that does not exist yet.
 *
 * A path whose ancestors cannot be resolved at all is refused rather than
 * assumed — the same rule the log-file check follows.
 */
function realTarget(target: string): string {
  const missing: string[] = [];
  let cursor = target;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync(cursor);
      return missing.length === 0 ? real : join(real, ...missing);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new ProjectWorkRefusedError(OUTSIDE);
      missing.unshift(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
  throw new ProjectWorkRefusedError(OUTSIDE);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The areas of a project no import reads and no export ever writes into.
 *
 * A repository's own storage, and this project's settings directory apart from
 * the export area inside it. Both are checked on the path as written *and* on
 * the path the filesystem resolves it to, so a link cannot reach them either.
 */
function refuseForbidden(relativePath: string): void {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  for (const [index, segment] of segments.entries()) {
    if (segment === ".git") {
      throw new ProjectWorkRefusedError(
        "That is a repository's own storage. Nothing is imported from it or exported into it. Name another folder inside this project.",
      );
    }
    if (segment !== PROJECT_DIR_NAME) continue;
    const next = segments[index + 1];
    if (next !== undefined && (next === WORK_EXPORT_DIR || EXPORT_REVISION_ROOT.test(next))) continue;
    throw new ProjectWorkRefusedError(
      `That is where this project's own settings are kept. Only ${PROJECT_DIR_NAME}/${WORK_EXPORT_DIR} is used for exports. Name another folder inside this project.`,
    );
  }
}

/**
 * What is at a path: a file, a directory, a link, or nothing. Never a throw.
 *
 * A link is its own answer rather than whatever it points at, so nothing here
 * mistakes one for a free name to write to or a file to delete.
 */
export function kindOf(path: string): "file" | "directory" | "link" | "none" {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "link";
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

/** Directories no adapter ever descends into. Build output, history, own state. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  PROJECT_DIR_NAME,
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  ".worktrees",
]);

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
        bytes = lstatSync(child).size;
      } catch {
        continue;
      }
      files.push({ path: childPath, absolute: child, bytes });
    }
  };
  visit(root, "", 0);
  return { files, truncated };
}

/**
 * Read one text file, refusing anything above the ceiling rather than loading
 * it, and refusing a link rather than following it.
 *
 * The descriptor is opened with `O_NOFOLLOW` and measured with `fstat`, so the
 * bytes that are read are the bytes of the file that was checked — not of
 * something that took its name in between.
 */
export function readTextFile(path: string, maxBytes: number): string | undefined {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: number;
  try {
    handle = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(handle);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return readFileSync(handle, "utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(handle);
  }
}

/**
 * Write one file, atomically and inside the project: the temporary file is
 * created exclusively and renamed, so a reader sees the previous document or
 * the new one and never half of either, and a link that appeared at either
 * name is refused rather than written through.
 */
export function writeFileAtomic(path: string, contents: string, options: { within: string }): void {
  ensureDirectory(options.within, dirname(path));
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // `wx` fails when anything already holds that name, a dangling link
    // included, so the bytes only ever land in a file this call created.
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Create the directory a write needs, and prove it is still inside the project
 * afterwards.
 *
 * The check is repeated after creation because that is the moment the write
 * depends on: a directory that resolves out of the project is a refusal with
 * nothing written, rather than a write that followed it.
 */
function ensureDirectory(within: string, directory: string): void {
  refuseOutside(within, directory);
  mkdirSync(directory, { recursive: true });
  let real: string;
  try {
    real = realpathSync(directory);
  } catch {
    throw new ProjectWorkRefusedError(OUTSIDE);
  }
  refuseOutside(within, real);
  refuseForbidden(relative(within, real));
}

/**
 * Remove one file. A file that is already gone is not an error, and a link is
 * not a file: a previous export's leftovers are documents, never a name
 * someone pointed somewhere else.
 */
export function removeFile(path: string): void {
  if (kindOf(path) !== "file") return;
  try {
    unlinkSync(path);
  } catch {
    // Gone between the check and the unlink: the outcome asked for, already.
  }
}
