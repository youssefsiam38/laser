import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { COPYFILE_FICLONE } from "node:constants";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  MigrationBoundary,
  MigrationRootLabel,
  MigrationRoots,
  MigrationUnit,
  SnapshotUnitManifest,
} from "./types.js";

const HASH = /^[0-9a-f]{64}$/;
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const posix = (value: string): string => value.split(sep).join("/");

export function safeMigrationPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && !isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function unitKey(unit: MigrationUnit): string {
  return `${unit.root}:${unit.path}:${unit.type}`;
}

export function validateUnit(unit: MigrationUnit): void {
  if (!["stateDir", "agentDir", "sessionDir"].includes(unit.root)
    || !safeMigrationPath(unit.path)
    || !["file", "directory"].includes(unit.type)
    || (unit.root === "stateDir" && (unit.path === "migration-state.json" || unit.path.startsWith("migration-snapshots/")))) {
    throw new Error("The staged update declared an unsafe migration path.");
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve without following any symlink in the unit path. */
export function resolveUnit(roots: MigrationRoots, unit: MigrationUnit): string {
  validateUnit(unit);
  const configured = roots[unit.root];
  mkdirSync(configured, { recursive: true, mode: 0o700 });
  const root = realpathSync(configured);
  const candidate = resolve(root, unit.path);
  if (!inside(root, candidate)) throw new Error("The staged update declared an unsafe migration path.");
  let cursor = root;
  for (const part of unit.path.split("/")) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Migration data cannot pass through a symbolic link.");
  }
  return candidate;
}

export function atomicWrite(path: string, bytes: string | Buffer, mode: number, boundary?: MigrationEngineBoundary): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temporary, "w", mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(temporary, mode);
  boundary?.("rename", path);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
}

export type MigrationEngineBoundary = (boundary: MigrationBoundary, detail: string) => void;

export function fsyncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* Windows cannot fsync directories. */ }
}

function copyFileReflink(source: string, destination: string, mode: number, boundary?: MigrationEngineBoundary): void {
  boundary?.("copy", source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try { copyFileSync(source, destination, COPYFILE_FICLONE); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOTSUP", "EOPNOTSUPP", "EINVAL", "EXDEV", "ENOSYS"].includes(code ?? "")) throw error;
    copyFileSync(source, destination);
  }
  chmodSync(destination, mode);
}

export function copyWhole(source: string, destination: string, type: MigrationUnit["type"], boundary?: MigrationEngineBoundary): void {
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new Error("Migration data cannot contain a symbolic link.");
  if (type === "file") {
    if (!sourceStat.isFile()) throw new Error("A declared migration file has the wrong type.");
    copyFileReflink(source, destination, sourceStat.mode & 0o777, boundary);
    return;
  }
  if (!sourceStat.isDirectory()) throw new Error("A declared migration directory has the wrong type.");
  mkdirSync(destination, { recursive: true, mode: sourceStat.mode & 0o777 });
  for (const name of readdirSync(source).sort()) {
    const childSource = join(source, name);
    const childDestination = join(destination, name);
    const child = lstatSync(childSource);
    if (child.isSymbolicLink()) throw new Error("Migration data cannot contain a symbolic link.");
    if (child.isDirectory()) copyWhole(childSource, childDestination, "directory", boundary);
    else if (child.isFile()) copyWhole(childSource, childDestination, "file", boundary);
    else throw new Error("Migration data contains an unsupported filesystem entry.");
  }
  chmodSync(destination, sourceStat.mode & 0o777);
}

interface TreeRow { path: string; type: "file" | "directory"; mode: number; length: number; sha256: string }

function describeTree(path: string, type: MigrationUnit["type"], boundary?: MigrationEngineBoundary): { mode: number; length: number; sha256: string } {
  const root = lstatSync(path);
  if (root.isSymbolicLink()) throw new Error("Migration data cannot contain a symbolic link.");
  if (type === "file") {
    if (!root.isFile()) throw new Error("A declared migration file has the wrong type.");
    boundary?.("hash", path);
    const bytes = readFileSync(path);
    return { mode: root.mode & 0o777, length: bytes.length, sha256: sha256(bytes) };
  }
  if (!root.isDirectory()) throw new Error("A declared migration directory has the wrong type.");
  const rows: TreeRow[] = [];
  let length = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const childPath = join(directory, name);
      const child = lstatSync(childPath);
      if (child.isSymbolicLink()) throw new Error("Migration data cannot contain a symbolic link.");
      const rel = posix(relative(path, childPath));
      if (child.isDirectory()) {
        rows.push({ path: rel, type: "directory", mode: child.mode & 0o777, length: 0, sha256: sha256("") });
        visit(childPath);
      } else if (child.isFile()) {
        boundary?.("hash", childPath);
        const bytes = readFileSync(childPath);
        length += bytes.length;
        rows.push({ path: rel, type: "file", mode: child.mode & 0o777, length: bytes.length, sha256: sha256(bytes) });
      } else throw new Error("Migration data contains an unsupported filesystem entry.");
    }
  };
  visit(path);
  boundary?.("hash", path);
  return {
    mode: root.mode & 0o777,
    length,
    sha256: sha256(rows.map((row) => `${row.path}\0${row.type}\0${row.mode}\0${row.length}\0${row.sha256}\n`).join("")),
  };
}

export function describeUnit(roots: MigrationRoots, unit: MigrationUnit, path = resolveUnit(roots, unit), boundary?: MigrationEngineBoundary): SnapshotUnitManifest {
  return { ...unit, ...describeTree(path, unit.type, boundary) };
}

export function verifyUnit(path: string, expected: SnapshotUnitManifest, boundary?: MigrationEngineBoundary): boolean {
  try {
    const actual = describeTree(path, expected.type, boundary);
    return actual.mode === expected.mode && actual.length === expected.length && actual.sha256 === expected.sha256;
  } catch (error) {
    // Fault injection must model process death, not a digest mismatch.
    if (boundary) throw error;
    return false;
  }
}

export function validSnapshotUnit(value: unknown): value is SnapshotUnitManifest {
  const unit = value as Partial<SnapshotUnitManifest> | undefined;
  try { if (unit) validateUnit(unit as MigrationUnit); else return false; } catch { return false; }
  return Number.isSafeInteger(unit.mode) && (unit.mode ?? -1) >= 0 && (unit.mode ?? 0) <= 0o777
    && Number.isSafeInteger(unit.length) && (unit.length ?? -1) >= 0
    && HASH.test(unit.sha256 ?? "");
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}
