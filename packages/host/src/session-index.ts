/**
 * A read-only index of one stored conversation (RP-9).
 *
 * The host already parses session JSONL without importing Pi (see
 * `catalog.ts`); this does the same for the part a revision needs: the header,
 * every entry's identity, the branch pointer, and the content fold those
 * produce. It never writes, never repairs and never migrates — the engine's own
 * loader appends a newline to an unterminated file, and this must not, because
 * the one-writer invariant is the whole reason a worker-free read is safe.
 *
 * What it deliberately does not do: keep entry bodies. A 50 MiB transcript
 * costs one pass and a few hundred kilobytes of identities, not a second copy
 * of the conversation. Growth costs only the new bytes.
 *
 * Three subtleties, each of which was a bug waiting to happen:
 *
 * - **The last line may have no newline.** The engine parses those bytes and
 *   keeps them as a real entry, so they are canonical history and are folded
 *   in — but the durable resume offset stops at the last newline, and that
 *   final entry is folded provisionally on top. When its newline finally
 *   arrives, the same entry is read once, not twice.
 * - **A torn line is not an entry.** Bytes that do not parse are excluded,
 *   exactly as the engine excludes them; a truncated JSON record cannot parse,
 *   so "parses" is the same proof the engine uses.
 * - **Nothing here treats a timestamp as content.** `(dev, ino, size, mtime,
 *   ctime)` decide only whether a *cached* index may be resumed, and every
 *   disagreement costs a full recompute rather than a stale answer.
 */
import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import {
  RevisionFold,
  sessionRevisionOf,
  type RevisionHasher,
  type RevisionState,
  type SessionRevisionHeader,
} from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

/**
 * The session format this host can read on its own. The engine rewrites an
 * older file when it opens it, and the host must never rewrite anything, so an
 * older session is routed to a worker instead of guessed at. Bumping the Pi pin
 * means checking this number against `CURRENT_SESSION_VERSION`.
 */
export const READABLE_SESSION_VERSION = 3;

/** Hard bounds. Exceeding one is reported, never absorbed by allocating more. */
export interface SessionIndexLimits {
  /** One record's bytes. A line larger than this is never buffered. */
  lineBytes: number;
  /** Records in one session. */
  entries: number;
  /** Retained identity/checkpoint bytes for one session. */
  indexBytes: number;
  /** The file itself. */
  fileBytes: number;
  /** How far back a cached revision can still be proved a prefix. */
  checkpoints: number;
}

export const DEFAULT_SESSION_INDEX_LIMITS: SessionIndexLimits = {
  lineBytes: 16 * 1024 * 1024,
  entries: 200_000,
  indexBytes: 8 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  checkpoints: 512,
};

/** One record's identity. Bodies are read later, by whoever needs them. */
export interface IndexedEntry {
  id: string | undefined;
  parentId: string | null;
}

export interface SessionIndex {
  header: SessionRevisionHeader;
  entries: IndexedEntry[];
  leafId: string | null;
  /** The fold over every entry, plus the leaf: what a revision is made of. */
  state: RevisionState;
  /** States a worker-free reader could have seen, newest last. */
  checkpoints: RevisionState[];
}

export type SessionIndexReason =
  /** No such file (deleted, moved, never written). */
  | "missing"
  /** Present, but not a session this host recognises. */
  | "not-a-session"
  /** An older session format the engine would rewrite on open. */
  | "unsupported-version"
  /** A hard bound (line, entry count, index bytes, file bytes). */
  | "too-large"
  /** The file could not be read. */
  | "unreadable"
  /** It kept being rewritten underneath the read. */
  | "changed"
  /** A record cannot be canonicalised, so no honest revision exists. */
  | "uncanonical";

export interface SessionIndexFailure {
  reason: SessionIndexReason;
  detail?: string;
}

export type SessionIndexResult = { ok: true; index: SessionIndex } | { ok: false; failure: SessionIndexFailure };

/** What one pass over the unread bytes produced. */
type ScanResult =
  | { ok: true; offset: number; tail?: { entry: IndexedEntry; state: RevisionState } }
  | { ok: false; failure: SessionIndexFailure };

interface Cached {
  /** Identity of the bytes this was built from; a hint, never a content proof. */
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** The header line's own digest, re-checked before any incremental resume. */
  headerDigest: string;
  header: SessionRevisionHeader;
  /** First byte after the last newline-terminated line that was folded. */
  offset: number;
  /**
   * The bytes immediately before `offset`, digested. Growth alone cannot tell
   * an append from a whole-file rewrite that happens to be longer — a
   * compaction is exactly that — so the prefix we are about to continue is
   * re-read and checked before anything is folded onto it.
   */
  anchor: { start: number; digest: string };
  durable: { fold: RevisionFold; entries: IndexedEntry[]; checkpoints: RevisionState[] };
  bytes: number;
  at: number;
}

const CHUNK = 256 * 1024;
const HEADER_SCAN = 8192;
/** How much of a cached prefix is re-read before it is continued. */
const ANCHOR_BYTES = 64 * 1024;
/** Rough retained cost of one identity row; the budget is bytes, not rows. */
const ENTRY_OVERHEAD = 64;

const failure = (reason: SessionIndexReason, detail?: string): { ok: false; failure: SessionIndexFailure } =>
  ({ ok: false, failure: detail === undefined ? { reason } : { reason, detail } });

export interface SessionIndexCacheOptions {
  limits?: Partial<SessionIndexLimits>;
  /** Indexed sessions retained. */
  sessions?: number;
  /** Retained bytes across all sessions. */
  bytes?: number;
  hash?: RevisionHasher;
  now?: () => number;
  /** Test seam for the rewrite-under-a-read check; defaults to `fstatSync`. */
  stat?: (fd: number) => Stats;
}

export class SessionIndexCache {
  private readonly cache = new Map<string, Cached>();
  private readonly limits: SessionIndexLimits;
  private readonly hash: RevisionHasher;
  private readonly sessions: number;
  private readonly byteLimit: number;
  private readonly now: () => number;
  private readonly stat: (fd: number) => Stats;
  private retained = 0;

  constructor(options: SessionIndexCacheOptions = {}) {
    this.limits = { ...DEFAULT_SESSION_INDEX_LIMITS, ...options.limits };
    this.hash = options.hash ?? nodeRevisionHasher;
    this.sessions = options.sessions ?? 8;
    this.byteLimit = options.bytes ?? 32 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.stat = options.stat ?? fstatSync;
  }

  /** Accounted identity bytes; diagnostics and the resource evidence. */
  get bytes(): number {
    return this.retained;
  }

  paths(): string[] {
    return [...this.cache.keys()];
  }

  invalidate(path: string): void {
    this.retained -= this.cache.get(path)?.bytes ?? 0;
    this.cache.delete(path);
  }

  clear(): void {
    this.cache.clear();
    this.retained = 0;
  }

  /** The index for a stored conversation, or why there is none. Never writes. */
  read(path: string): SessionIndexResult {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = this.attempt(path);
      if (result.ok || result.failure.reason !== "changed") return result;
    }
    return failure("changed");
  }

  /** The revision of a stored conversation, bound to this environment. */
  revision(path: string, environmentTag: string): { ok: true; index: SessionIndex; revision: string } | { ok: false; failure: SessionIndexFailure } {
    const result = this.read(path);
    if (!result.ok) return result;
    return { ok: true, index: result.index, revision: sessionRevisionOf(this.hash, environmentTag, result.index.state) };
  }

  private attempt(path: string): SessionIndexResult {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      const code = (error as { code?: string }).code;
      return failure(code === "ENOENT" ? "missing" : "unreadable", code);
    }
    try {
      const before = this.stat(fd);
      if (!before.isFile()) return failure("not-a-session", "not a file");
      if (before.size === 0) return failure("not-a-session", "empty");
      if (before.size > this.limits.fileBytes) return failure("too-large", "file");

      const headerLine = this.readHeaderLine(fd, before.size);
      if (!headerLine) return failure("not-a-session", "no header");
      const header = parseHeader(headerLine.text);
      if (!header) return failure("not-a-session", "header");
      if ((header.version ?? 1) !== READABLE_SESSION_VERSION) return failure("unsupported-version", String(header.version ?? 1));
      const headerDigest = this.hash(headerLine.text);

      const cached = this.resumable(path, before, headerDigest, fd);
      const durable = cached
        ? cached.durable
        : { fold: RevisionFold.create(this.hash, header), entries: [] as IndexedEntry[], checkpoints: [] as RevisionState[] };
      const from = cached ? cached.offset : headerLine.end;

      const scan = this.scan(fd, from, before.size, durable);
      // A partly folded durable state must never be reused: it describes bytes
      // this read could not finish proving.
      if (!scan.ok) {
        this.invalidate(path);
        return scan;
      }

      // Appends after the snapshot are invisible to this read; a rewrite is
      // not, and must never be folded into a half-old index.
      const after = this.stat(fd);
      if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size) {
        this.invalidate(path);
        return failure("changed", "rewritten");
      }
      if (after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) {
        this.invalidate(path);
        return failure("changed", "touched");
      }

      this.store(path, before, { headerDigest, header, offset: scan.offset, anchor: this.anchor(fd, headerLine.end, scan.offset), durable });

      const entries = scan.tail ? [...durable.entries, scan.tail.entry] : durable.entries;
      const state: RevisionState = { ...(scan.tail ? scan.tail.state : durable.fold.state), leafId: entries[entries.length - 1]?.id ?? null };
      const checkpoints = scan.tail
        ? [...durable.checkpoints, { ...scan.tail.state, leafId: scan.tail.entry.id ?? null }]
        : durable.checkpoints;
      return { ok: true, index: { header, entries, leafId: state.leafId, state, checkpoints } };
    } catch (error) {
      return failure("unreadable", (error as { code?: string }).code ?? "read failed");
    } finally {
      closeSync(fd);
    }
  }

  /**
   * A cached index may only continue a file that has the same identity, the
   * same header bytes and at least the same length. Anything else is recomputed
   * from the start — the cost of being wrong here is a stale conversation.
   */
  private resumable(path: string, stats: Stats, headerDigest: string, fd: number): Cached | undefined {
    const cached = this.cache.get(path);
    if (!cached) return undefined;
    const same = cached.dev === stats.dev && cached.ino === stats.ino && cached.headerDigest === headerDigest && stats.size >= cached.size;
    // Same length and an untouched timestamp pair: nothing happened at all.
    const untouched = stats.size === cached.size && stats.mtimeMs === cached.mtimeMs && stats.ctimeMs === cached.ctimeMs;
    // Rewritten in place at the same length, or a longer file whose prefix is
    // no longer the one we folded: either way the identities we hold may
    // describe bytes that are gone.
    const continues = untouched || this.anchor(fd, cached.anchor.start, cached.offset).digest === cached.anchor.digest;
    if (!same || !continues) {
      this.invalidate(path);
      return undefined;
    }
    return cached;
  }

  /** A bounded digest of the bytes a later read would continue from. */
  private anchor(fd: number, headerEnd: number, offset: number): { start: number; digest: string } {
    const start = Math.max(headerEnd, offset - ANCHOR_BYTES);
    const length = offset - start;
    if (length <= 0) return { start: offset, digest: this.hash("") };
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return { start, digest: this.hash(buffer.subarray(0, read).toString("latin1")) };
  }

  private readHeaderLine(fd: number, size: number): { text: string; end: number } | undefined {
    const buffer = Buffer.alloc(Math.min(size, HEADER_SCAN));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    if (read <= 0) return undefined;
    const slice = buffer.subarray(0, read);
    const newline = slice.indexOf(0x0a);
    if (newline < 0 && read === HEADER_SCAN) return undefined;
    const line = newline >= 0 ? slice.subarray(0, newline) : slice;
    return { text: line.toString("utf8"), end: newline >= 0 ? newline + 1 : read };
  }

  /**
   * Fold `[from, size)` into the durable state, and report the unterminated
   * final record separately so it is never counted twice.
   */
  private scan(
    fd: number,
    from: number,
    size: number,
    durable: { fold: RevisionFold; entries: IndexedEntry[]; checkpoints: RevisionState[] },
  ): ScanResult {
    const buffer = Buffer.alloc(CHUNK);
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let position = from;
    let offset = from;

    const fold = (line: Buffer): { ok: false; failure: SessionIndexFailure } | undefined => {
      const entry = parseEntry(line.toString("utf8"));
      if (!entry) return undefined; // a torn or blank line is not a record, exactly as the engine sees it
      if (durable.entries.length >= this.limits.entries) return failure("too-large", "entries");
      try {
        durable.fold.push(entry.value);
      } catch (error) {
        return failure("uncanonical", error instanceof Error ? error.message : undefined);
      }
      durable.entries.push(entry.identity);
      durable.checkpoints.push({ ...durable.fold.state, leafId: entry.identity.id ?? null });
      if (durable.checkpoints.length > this.limits.checkpoints) durable.checkpoints.splice(0, durable.checkpoints.length - this.limits.checkpoints);
      if (indexBytes(durable) > this.limits.indexBytes) return failure("too-large", "index");
      return undefined;
    };

    while (position < size) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position);
      if (read <= 0) break;
      position += read;
      const chunk = buffer.subarray(0, read);
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) break;
        const end = chunk.subarray(start, newline);
        if (fragmentBytes + end.length > this.limits.lineBytes) return failure("too-large", "line");
        const line = fragmentBytes === 0 ? end : Buffer.concat([...fragments, end], fragmentBytes + end.length);
        const problem = fold(line);
        if (problem) return problem;
        fragments = [];
        fragmentBytes = 0;
        start = newline + 1;
        offset = position - read + start;
      }
      if (start < read) {
        const fragment = Buffer.from(chunk.subarray(start));
        if (fragmentBytes + fragment.length > this.limits.lineBytes) return failure("too-large", "line");
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
    }

    // The engine keeps a final record that has no newline yet, so this must
    // too — provisionally, because those bytes are still unterminated on disk.
    if (fragmentBytes > 0) {
      const entry = parseEntry(Buffer.concat(fragments, fragmentBytes).toString("utf8"));
      if (entry) {
        if (durable.entries.length >= this.limits.entries) return failure("too-large", "entries");
        const provisional = RevisionFold.resume(this.hash, durable.fold.state);
        try {
          provisional.push(entry.value);
        } catch (error) {
          return failure("uncanonical", error instanceof Error ? error.message : undefined);
        }
        return { ok: true, offset, tail: { entry: entry.identity, state: { ...provisional.state, leafId: entry.identity.id ?? null } } };
      }
    }
    return { ok: true, offset };
  }

  private store(path: string, stats: Stats, parts: Omit<Cached, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "bytes" | "at">): void {
    this.invalidate(path);
    const bytes = indexBytes(parts.durable);
    const entry: Cached = {
      ...parts,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      bytes,
      at: this.now(),
    };
    this.cache.set(path, entry);
    this.retained += bytes;
    while (this.cache.size > this.sessions || this.retained > this.byteLimit) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      if (oldest.value === path && this.cache.size === 1) break;
      this.invalidate(oldest.value);
    }
  }
}

function indexBytes(durable: { entries: IndexedEntry[]; checkpoints: RevisionState[] }): number {
  let bytes = 0;
  for (const entry of durable.entries) bytes += ENTRY_OVERHEAD + ((entry.id?.length ?? 0) + (entry.parentId?.length ?? 0)) * 2;
  for (const checkpoint of durable.checkpoints) bytes += ENTRY_OVERHEAD + (checkpoint.digest.length + (checkpoint.leafId?.length ?? 0)) * 2;
  return bytes;
}

function parseHeader(line: string): SessionRevisionHeader | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const header = parsed as { type?: unknown; id?: unknown; cwd?: unknown; parentSession?: unknown; version?: unknown } | null;
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
  return {
    id: header.id,
    // The header's own working directory, not the project a row is grouped
    // under: the engine folds exactly what it wrote here.
    cwd: header.cwd,
    ...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {}),
    ...(typeof header.version === "number" ? { version: header.version } : {}),
  };
}

/** A record the engine would keep: parseable, and not a second header line. */
function parseEntry(line: string): { value: unknown; identity: IndexedEntry } | undefined {
  if (!line.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = parsed as { type?: unknown; id?: unknown; parentId?: unknown } | null;
  if (entry?.type === "session") return undefined;
  return {
    value: parsed,
    identity: {
      id: typeof entry?.id === "string" ? entry.id : undefined,
      parentId: typeof entry?.parentId === "string" ? entry.parentId : null,
    },
  };
}
