/**
 * Bitbucket has no viewed-file API we can write. Marks live in a small JSON
 * file on this machine, keyed by workspace/repo#number, never synced.
 *
 * Writes are temp + rename. A file that does not parse is never overwritten.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { GitActionConfirmation, GitActionResult } from "@lasercode/protocol";
import { GitActionError } from "./paths.js";
import type { ParsedRemote } from "./remotes.js";
import { bitbucketRepo } from "./remotes.js";

interface Store {
  [key: string]: Record<string, boolean>;
}

export function viewedKey(remote: ParsedRemote, number: number): string {
  const { workspace, repo } = bitbucketRepo(remote);
  return `${workspace}/${repo}#${number}`;
}

function isStore(value: unknown): value is Store {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  for (const row of Object.values(value as Record<string, unknown>)) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
    for (const mark of Object.values(row as Record<string, unknown>)) {
      if (typeof mark !== "boolean") return false;
    }
  }
  return true;
}

export function readViewedStore(file: string): Store {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new GitActionError("The viewed-file store could not be read. Fix or remove it, then try again.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GitActionError("The viewed-file store could not be parsed. Fix or remove it, then try again.");
  }
  if (!isStore(parsed)) {
    throw new GitActionError("The viewed-file store is not valid. Fix or remove it, then try again.");
  }
  return parsed;
}

function writeViewedStore(file: string, store: Store): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error;
  }
}

export function listViewed(file: string, remote: ParsedRemote, number: number): Map<string, boolean> {
  const row = readViewedStore(file)[viewedKey(remote, number)] ?? {};
  return new Map(Object.entries(row));
}

export function setLocalViewed(
  file: string,
  repo: string,
  remote: ParsedRemote,
  number: number,
  path: string,
  viewed: boolean,
  message?: string,
): GitActionResult & { path: string; viewed: boolean } {
  const store = readViewedStore(file);
  const key = viewedKey(remote, number);
  const row = { ...(store[key] ?? {}) };
  if (viewed) row[path] = true;
  else delete row[path];
  if (Object.keys(row).length === 0) delete store[key];
  else store[key] = row;
  writeViewedStore(file, store);
  const confirmation: GitActionConfirmation = {
    repo,
    branch: "",
    files: [path],
    summary: viewed ? `Mark ${path} viewed on pull request ${number}.` : `Mark ${path} unviewed on pull request ${number}.`,
  };
  return {
    outcome: "done",
    confirmation,
    path,
    viewed,
    ...(message ? { message } : {}),
  };
}
