/**
 * SessionCatalog (M1-T2, M2-T3) — lists Pi session files across all projects
 * without importing Pi. Reads the session header, then scans the rest of the
 * file for the three things a sidebar row needs (name, first message, message
 * count), cached by (size, mtime) and continued from the last scanned offset so
 * a growing transcript is only ever read once.
 *
 * Line scanning follows @tmustier/pi-usage-extension: a substring test decides
 * whether a line is worth `JSON.parse`. Only `session_info` lines (rename) and
 * the first user message are ever parsed; message counting is substring-only,
 * so a 50 MiB transcript costs one pass of `indexOf`, not one parse per line.
 *
 * Layouts (Pi 0.85):
 *   default dir   <agentDir>/sessions/<slug-of-cwd>/<timestamp>_<uuid>.jsonl
 *   explicit dir  <sessionDir>/<timestamp>_<uuid>.jsonl        (flat; verified)
 * Both are scanned. Header line:
 *   {"type":"session","version":3,"id","timestamp","cwd","parentSession"?}
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultAgentDir, projectRootOf } from "./paths.js";
import type { SessionAgentInfo, SessionAgentRecord, SessionSummary } from "@lasercode/protocol";
import { SESSION_AGENT_ENTRY_TYPE, goalPromptId, toolOutputText } from "@lasercode/protocol";

export interface CatalogEntry extends SessionSummary {
  size: number;
}

/** What one pass over the file body found, and where to resume next time. */
interface Scan {
  /** Byte offset of the first unscanned (or partially written) line. */
  offset: number;
  messageCount: number;
  firstMessage?: string | undefined;
  name?: string | undefined;
  pendingGoal?: { id: string; text: string } | undefined;
  /** From the session's agent record, when the worker wrote one (docs/agents-leap). */
  agent?: SessionAgentInfo | undefined;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  entry: CatalogEntry | null;
  scan?: Scan;
}

/** Chunk size for the body scan. Big enough that most sessions are one read. */
const CHUNK = 256 * 1024;
/** A row shows one line; keep the rest out of memory and off the wire. */
const FIRST_MESSAGE_MAX = 200;
/** The substring that marks the agent record, so the line is parsed only when it is one. */
const AGENT_RECORD_MARK = `"customType":${JSON.stringify(SESSION_AGENT_ENTRY_TYPE)}`;

export function defaultSessionDir(agentDir = defaultAgentDir()): string {
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

  /** One session, or null when the file is gone or not a Pi session. */
  get(path: string): CatalogEntry | null {
    return this.read(path);
  }

  /** The cwd recorded in a session file's header, or undefined if unreadable. */
  cwdOf(path: string): string | undefined {
    return this.read(path)?.cwd;
  }

  /** Every directory that has at least one session, with its session count. */
  cwdCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const entry of this.list()) counts.set(entry.cwd, (counts.get(entry.cwd) ?? 0) + 1);
    return counts;
  }

  /** Drop a cached read so the next one hits the disk (a fork rewrote the file). */
  invalidate(path: string): void {
    this.cache.delete(path);
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

    const header = parseHeader(path, st.size, st.mtimeMs);
    if (!header) {
      this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, entry: null });
      return null;
    }
    // Continue the previous scan when the file only grew; restart when it was
    // rewritten or truncated (a torn tail repaired by Pi's reader, a fork).
    const previous = cached && cached.size < st.size && cached.scan ? cached.scan : undefined;
    const scan = scanBody(path, st.size, previous ?? { offset: header.bodyOffset, messageCount: 0 });
    const entry: CatalogEntry = {
      ...header.entry,
      messageCount: scan.messageCount,
      ...(scan.name ? { name: scan.name } : {}),
      ...(scan.firstMessage ? { firstMessage: scan.firstMessage } : {}),
      ...(scan.agent ? { agent: scan.agent } : {}),
    };
    this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, entry, scan });
    return entry;
  }
}

interface Header {
  entry: CatalogEntry;
  /** Byte offset just past the header line. */
  bodyOffset: number;
}

function parseHeader(path: string, size: number, mtimeMs: number): Header | null {
  if (size === 0) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const slice = buf.subarray(0, n);
    const nl = slice.indexOf(0x0a);
    const line = (nl >= 0 ? slice.subarray(0, nl) : slice).toString("utf8");
    const header = JSON.parse(line) as {
      type?: string;
      id?: string;
      cwd?: string;
      name?: string;
      timestamp?: string;
      parentSession?: string;
    };
    if (header.type !== "session" || !header.id || !header.cwd) return null;
    return {
      bodyOffset: nl >= 0 ? nl + 1 : n,
      entry: {
        path,
        id: header.id,
        // A child agent's header names its worktree; the row, the worker and
        // the sidebar group are the project's (docs/agents-leap).
        cwd: projectRootOf(header.cwd),
        createdAt: header.timestamp ?? new Date(mtimeMs).toISOString(),
        modifiedAt: new Date(mtimeMs).toISOString(),
        messageCount: 0,
        size,
        ...(header.name ? { name: header.name } : {}),
        // A fork's origin is lineage, not a parent: a fork is its own top-level
        // session. Only an agent record nests a session (M13-T65).
        ...(header.parentSession ? { forkedFrom: header.parentSession } : {}),
      },
    };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan `[from.offset, size)` for message lines. Stops at the last newline so a
 * half-written line is re-read next time instead of being parsed as garbage.
 */
function scanBody(path: string, size: number, from: Scan): Scan {
  const result: Scan = { ...from };
  if (result.offset >= size) return result;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return result;
  }
  const buffer = Buffer.alloc(CHUNK);
  // Bytes, not a string: a multi-byte character split across two reads would
  // decode to U+FFFD and desynchronise the byte offset we resume from.
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let position = result.offset;
  try {
    while (position < size) {
      const n = readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position);
      if (n <= 0) break;
      position += n;
      const chunk = buffer.subarray(0, n);
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1) break;
        const end = chunk.subarray(start, nl);
        const line = fragmentBytes === 0 ? end : Buffer.concat([...fragments, end], fragmentBytes + end.length);
        applyLine(line.toString("utf8"), result);
        fragments = [];
        fragmentBytes = 0;
        start = nl + 1;
        result.offset = position - n + start;
      }
      // The read buffer is reused. Copy each unfinished fragment once, then
      // assemble only at newline; never rescan/copy the accumulated prefix.
      if (start < n) {
        const fragment = Buffer.from(chunk.subarray(start));
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
      // Do not retain potentially enormous partial records in the catalog.
      // offset stays at their start so a later completed write is interpreted.
    }
  } catch {
    /* a session being written under us: keep what we have */
  } finally {
    closeSync(fd);
  }
  return result;
}

/**
 * Substring tests first: over a large transcript this runs on every line, and
 * `JSON.parse` is two orders of magnitude more expensive than `indexOf`.
 * Requiring both `"type":"message"` and the role makes a false positive need a
 * message whose own text contains a JSON message envelope.
 */
function applyLine(line: string, scan: Scan): void {
  if (line.length < 16) return;
  if (scan.agent === undefined && line.includes(AGENT_RECORD_MARK)) {
    try {
      const entry = JSON.parse(line) as { type?: string; customType?: string; data?: SessionAgentRecord };
      if (entry.type === "custom" && entry.customType === SESSION_AGENT_ENTRY_TYPE) scan.agent = agentInfoOf(entry.data);
    } catch {
      /* torn line */
    }
    return;
  }
  if (scan.firstMessage === undefined && line.includes('"customType":"goal-state"')) {
    try {
      const entry = JSON.parse(line);
      const goal = entry.type === "custom" ? entry.data?.goal : undefined;
      scan.pendingGoal = goal && typeof goal.id === "string" && typeof goal.text === "string" ? { id: goal.id, text: goal.text } : undefined;
    } catch { /* torn line */ }
    return;
  }
  if (line.includes('"type":"session_info"')) {
    try {
      const entry = JSON.parse(line) as { name?: unknown };
      // A rename to "" clears the name, exactly as Pi renders it.
      if (typeof entry.name === "string") scan.name = entry.name || undefined;
    } catch {
      /* torn line */
    }
    return;
  }
  if (!line.includes('"type":"message"')) return;
  const user = line.includes('"role":"user"');
  if (!user && !line.includes('"role":"assistant"')) return;
  scan.messageCount++;
  if (!user || scan.firstMessage !== undefined) return;
  try {
    const entry = JSON.parse(line) as { message?: { content?: unknown } };
    const raw = typeof entry.message?.content === "string" ? entry.message.content : toolOutputText(entry.message) ?? "";
    const text = textOf(scan.pendingGoal && goalPromptId(raw) === scan.pendingGoal.id ? scan.pendingGoal.text : entry.message?.content);
    if (text) scan.firstMessage = text;
    scan.pendingGoal = undefined;
  } catch {
    /* torn line */
  }
}

/**
 * The attribution a sidebar row needs, from the record the worker wrote. The
 * run id and status are the registry's business (the router adds them), so a
 * catalog that only reads files stays pure.
 */
function agentInfoOf(record: SessionAgentRecord | undefined): SessionAgentInfo | undefined {
  if (!record || typeof record.agentName !== "string") return undefined;
  const kind = record.kind;
  if (kind !== "root" && kind !== "child" && kind !== "beam" && kind !== "chat") return undefined;
  return {
    agentName: record.agentName,
    kind,
    ...(typeof record.subagentName === "string" ? { subagentName: record.subagentName } : {}),
    ...(typeof record.parentPath === "string" ? { parentPath: record.parentPath } : {}),
    ...(typeof record.rootPath === "string" ? { rootPath: record.rootPath } : {}),
  };
}

/** Pi content is a string or a list of parts; only text parts are shown. */
function textOf(content: unknown): string | undefined {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part): part is { type: "text"; text: string } => {
              const p = part as { type?: unknown; text?: unknown };
              return p?.type === "text" && typeof p.text === "string";
            })
            .map((part) => part.text)
            .join(" ")
        : "";
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > FIRST_MESSAGE_MAX ? `${collapsed.slice(0, FIRST_MESSAGE_MAX - 1)}…` : collapsed;
}
