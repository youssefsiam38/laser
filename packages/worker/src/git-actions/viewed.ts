/**
 * Bitbucket has no viewed-file API we can write. Marks live in a small JSON
 * file on this machine, keyed by workspace/repo#number, never synced.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GitActionConfirmation, GitActionResult } from "@lasercode/protocol";
import type { ParsedRemote } from "./remotes.js";
import { bitbucketRepo } from "./remotes.js";

interface Store {
  [key: string]: Record<string, boolean>;
}

export function viewedKey(remote: ParsedRemote, number: number): string {
  const { workspace, repo } = bitbucketRepo(remote);
  return `${workspace}/${repo}#${number}`;
}

export function readViewedStore(file: string): Store {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Store;
  } catch {
    // Missing or corrupt: start empty. A corrupt file is not a credential.
  }
  return {};
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
): GitActionResult & { path: string; viewed: boolean } {
  const store = readViewedStore(file);
  const key = viewedKey(remote, number);
  const row = { ...(store[key] ?? {}) };
  if (viewed) row[path] = true;
  else delete row[path];
  if (Object.keys(row).length === 0) delete store[key];
  else store[key] = row;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const confirmation: GitActionConfirmation = {
    repo,
    branch: "",
    files: [path],
    summary: viewed ? `Mark ${path} viewed on pull request ${number}.` : `Mark ${path} unviewed on pull request ${number}.`,
  };
  return { outcome: "done", confirmation, path, viewed };
}
