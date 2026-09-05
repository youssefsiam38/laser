/**
 * SessionCatalog (M1-T2) — lists Pi session files across all projects without
 * importing Pi. Reads only the first line (the session header) and file stats,
 * cached by (size, mtime) so repeat scans are cheap. Pi has no index; this is
 * the O(all sessions) walk that `SessionManager.listAll()` also does, but
 * bounded to a header read per file.
 *
 * Layouts (Pi 0.85):
 *   default dir   <agentDir>/sessions/<slug-of-cwd>/<timestamp>_<uuid>.jsonl
 *   explicit dir  <sessionDir>/<timestamp>_<uuid>.jsonl        (flat; verified)
 * Both are scanned. Header line:
 *   {"type":"session","version":3,"id","timestamp","cwd","parentSession"?}
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@piorbit/protocol";

export interface CatalogEntry extends SessionSummary {
  size: number;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  entry: CatalogEntry | null;
}

export function defaultSessionDir(agentDir = join(homedir(), ".pi", "agent")): string {
  return join(agentDir, "sessions");
}

export class SessionCatalog {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(readonly sessionDir: string) {}

  /** All sessions, newest first. Pass `cwd` to filter to one project. */
  list(cwd?: string): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    const consider = (path: string) => {
      const entry = this.read(path);
      if (entry && (!cwd || entry.cwd === cwd)) out.push(entry);
    };
    let names: string[];
    try {
      names = readdirSync(this.sessionDir);
    } catch {
      return out;
    }
    for (const name of names) {
      const full = join(this.sessionDir, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) {
        if (name.endsWith(".jsonl")) consider(full);
        continue;
      }
      let files: string[];
      try {
        files = readdirSync(full);
      } catch {
        continue;
      }
      for (const file of files) if (file.endsWith(".jsonl")) consider(join(full, file));
    }
    out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : a.modifiedAt > b.modifiedAt ? -1 : 0));
    return out;
  }

  /** The cwd recorded in a session file's header, or undefined if unreadable. */
  cwdOf(path: string): string | undefined {
    return this.read(path)?.cwd;
  }

  private read(path: string): CatalogEntry | null {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      this.cache.delete(path);
      return null;
    }
    const cached = this.cache.get(path);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.entry;

    const entry = parseHeader(path, st.size, st.mtimeMs);
    this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, entry });
    return entry;
  }
}

function parseHeader(path: string, size: number, mtimeMs: number): CatalogEntry | null {
  if (size === 0) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    const line = nl >= 0 ? text.slice(0, nl) : text;
    const header = JSON.parse(line) as {
      type?: string;
      id?: string;
      cwd?: string;
      timestamp?: string;
      parentSession?: string;
    };
    if (header.type !== "session" || !header.id || !header.cwd) return null;
    return {
      path,
      id: header.id,
      cwd: header.cwd,
      createdAt: header.timestamp ?? new Date(mtimeMs).toISOString(),
      modifiedAt: new Date(mtimeMs).toISOString(),
      messageCount: 0,
      size,
      ...(header.parentSession ? { parentPath: header.parentSession } : {}),
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
