/**
 * Moving a saved session into a project (M13-T58, `pi/session/move`).
 *
 * A Chat session and a project session are the same kind of file; what
 * differs is where it lives, which directory its header names and which agent
 * its first custom entry records. So a move is a rewrite of exactly those
 * three things, done by the host while no worker holds the file (AGENTS.md
 * invariants 5 and 8), atomically: the new file is written beside its
 * destination and renamed into place before the old one goes, so a crash in
 * the middle leaves one complete session on disk, never none.
 *
 * Pure file work only. The router decides whether a move is allowed and
 * keeps every cache in step; nothing here reads the pool or the registry.
 */
import { SESSION_AGENT_ENTRY_TYPE } from "@lasercode/protocol";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The substring that marks the agent record, so only that line is parsed. */
const AGENT_RECORD_MARK = `"customType":${JSON.stringify(SESSION_AGENT_ENTRY_TYPE)}`;

/**
 * The engine's own rule for a project's session directory (verified against
 * Pi 0.85 `getDefaultSessionDirPath`): the absolute directory with its leading
 * separator dropped and every `/`, `\` and `:` turned into `-`, wrapped in
 * `--`. Reproduced here rather than imported because the host imports no
 * engine; `packages/host/test/session-move.test.ts` pins the shape.
 */
export function sessionDirFor(sessionRoot: string, cwd: string): string {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionRoot, safe);
}

/**
 * Where a session file goes when its project becomes `cwd`. The default
 * layout keeps one directory per project under the session root; a host
 * started with an explicit flat session directory (every file directly in the
 * root) keeps the file where it is, and only the header changes.
 */
export function destinationFor(sessionRoot: string, path: string, cwd: string): string {
  if (resolve(dirname(path)) === resolve(sessionRoot)) return path;
  return join(sessionDirFor(sessionRoot, cwd), basename(path));
}

export interface MoveRewrite {
  /** The project the header will name. */
  cwd: string;
  /** The agent the session runs as from now on: a plain top-level session of it. */
  agentName: string;
}

/**
 * Rewrite `path` into `dest` with its header pointing at `cwd` and its agent
 * record — the first `SESSION_AGENT_ENTRY_TYPE` entry, which is the one the
 * catalog and the worker read — turned into a top-level record of
 * `agentName`, with no workspace kind. The line is replaced in place, never
 * appended after: the first record wins everywhere it is read. A session with
 * no record gets none; a session that already had one keeps exactly one.
 *
 * Throws when the file is not a session; leaves both paths untouched then.
 */
export function rewriteSessionFile(path: string, dest: string, rewrite: MoveRewrite): void {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const header = JSON.parse(lines[0] ?? "") as { type?: string; cwd?: string };
  if (header.type !== "session" || typeof header.cwd !== "string") throw new Error(`${path} is not a session file.`);
  lines[0] = JSON.stringify({ ...header, cwd: rewrite.cwd });
  let recordSeen = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(AGENT_RECORD_MARK)) continue;
    let entry: { type?: string; customType?: string; data?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // a message whose text quotes the marker, or a torn line: not the record
    }
    if (entry.type !== "custom" || entry.customType !== SESSION_AGENT_ENTRY_TYPE) continue;
    if (recordSeen) continue; // later records are already ignored by every reader
    recordSeen = true;
    lines[i] = JSON.stringify({ ...entry, data: { agentName: rewrite.agentName, kind: "root" } });
  }
  mkdirSync(dirname(dest), { recursive: true });
  const temp = join(dirname(dest), `.${basename(dest)}.${process.pid}.moving`);
  try {
    writeFileSync(temp, lines.join("\n"));
    renameSync(temp, dest);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (resolve(dest) !== resolve(path) && existsSync(path)) unlinkSync(path);
}
