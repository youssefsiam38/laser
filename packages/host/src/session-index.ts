/**
 * A read-only, incrementally accounted index of one stored conversation (RP-9).
 *
 * The host never repairs or migrates a session. It folds canonical entries,
 * keeps only identities/checkpoints, and yields while doing a cold scan so a
 * large transcript cannot monopolize host delivery.
 */
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs";
import {
  RevisionFold,
  historyWindowNode,
  sessionRevisionOf,
  type RevisionHasher,
  type RevisionState,
  type SessionRevisionHeader,
} from "@lasercode/protocol";
import { nodeRevisionHasher } from "@lasercode/protocol/revision-node";

export const READABLE_SESSION_VERSION = 3;

export interface SessionIndexLimits {
  lineBytes: number;
  entries: number;
  indexBytes: number;
  fileBytes: number;
  checkpoints: number;
}

/**
 * The entry cap is intentionally below the 8 MiB accounted-identity budget.
 * With UUID-sized ids, 32k identity rows plus the checkpoint ring account for
 * about 6.8 MiB. Unusually long ids bind on `indexBytes` first.
 */
export const DEFAULT_SESSION_INDEX_LIMITS: SessionIndexLimits = {
  lineBytes: 16 * 1024 * 1024,
  entries: 32_000,
  indexBytes: 8 * 1024 * 1024,
  fileBytes: 256 * 1024 * 1024,
  checkpoints: 512,
};

export interface IndexedEntry {
  id: string | undefined;
  parentId: string | null;
  isMessage: boolean;
  isUser: boolean;
  isGoalState: boolean;
  goalPromptId?: string | undefined;
  /** Byte range of the JSON object only; the newline is never materialised. */
  offset: number;
  length: number;
}

export interface SessionIndex {
  header: SessionRevisionHeader;
  entries: IndexedEntry[];
  leafId: string | null;
  state: RevisionState;
  checkpoints: RevisionState[];
  /** Exact file snapshot the fold and line offsets describe. */
  identity: FileIdentity;
}

export type SessionIndexReason =
  | "missing"
  | "not-a-session"
  | "unsupported-version"
  | "too-large"
  | "unreadable"
  | "changed"
  | "uncanonical";

export interface SessionIndexFailure {
  reason: SessionIndexReason;
  detail?: string;
}

export type SessionIndexResult = { ok: true; index: SessionIndex } | { ok: false; failure: SessionIndexFailure };

type ScanResult =
  | { ok: true; offset: number; tail?: { entry: IndexedEntry; state: RevisionState } }
  | { ok: false; failure: SessionIndexFailure };

interface Durable {
  fold: RevisionFold;
  entries: IndexedEntry[];
  /** Fixed ring; `checkpointStart` is the oldest slot once full. */
  checkpoints: RevisionState[];
  checkpointStart: number;
  /** Accounted JS identity data, not process RSS or allocator capacity. */
  bytes: number;
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface Cached extends FileIdentity {
  headerDigest: string;
  header: SessionRevisionHeader;
  offset: number;
  anchor: { start: number; digest: string };
  durable: Durable;
  bytes: number;
  at: number;
}

interface NegativeCached extends FileIdentity {
  failure: SessionIndexFailure;
  at: number;
}

const CHUNK = 256 * 1024;
const HEADER_SCAN = 8192;
const ANCHOR_BYTES = 64 * 1024;
const ENTRY_OVERHEAD = 64;
const DEFAULT_YIELD_LINES = 8;
const RETRIES = 3;
const NEGATIVE_REASONS = new Set<SessionIndexReason>(["too-large", "unsupported-version", "unreadable"]);

const failure = (reason: SessionIndexReason, detail?: string): { ok: false; failure: SessionIndexFailure } =>
  ({ ok: false, failure: detail === undefined ? { reason } : { reason, detail } });

const identityOf = (stats: Stats): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

const entryBytes = (entry: IndexedEntry): number =>
  ENTRY_OVERHEAD + ((entry.id?.length ?? 0) + (entry.parentId?.length ?? 0) + (entry.goalPromptId?.length ?? 0)) * 2 + 16;
const checkpointBytes = (checkpoint: RevisionState): number =>
  ENTRY_OVERHEAD + (checkpoint.digest.length + (checkpoint.leafId?.length ?? 0)) * 2 + 16;

export interface SessionIndexCacheOptions {
  limits?: Partial<SessionIndexLimits>;
  sessions?: number;
  bytes?: number;
  hash?: RevisionHasher;
  now?: () => number;
  stat?: (fd: number) => Stats;
  /** Test seam; production yields to the next event-loop turn. */
  yield?: () => Promise<void>;
  /** Maximum physical lines processed between cooperative yields. */
  yieldEveryLines?: number;
}

export class SessionIndexCache {
  private readonly cache = new Map<string, Cached>();
  private readonly negative = new Map<string, NegativeCached>();
  private readonly inflight = new Map<string, Promise<SessionIndexResult>>();
  private readonly limits: SessionIndexLimits;
  private readonly hash: RevisionHasher;
  private readonly sessions: number;
  private readonly byteLimit: number;
  private readonly now: () => number;
  private readonly stat: (fd: number) => Stats;
  private readonly yieldToHost: () => Promise<void>;
  private readonly yieldEveryLines: number;
  private retained = 0;

  constructor(options: SessionIndexCacheOptions = {}) {
    this.limits = { ...DEFAULT_SESSION_INDEX_LIMITS, ...options.limits };
    this.hash = options.hash ?? nodeRevisionHasher;
    this.sessions = options.sessions ?? 8;
    this.byteLimit = options.bytes ?? 32 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.stat = options.stat ?? fstatSync;
    this.yieldToHost = options.yield ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.yieldEveryLines = Math.max(1, options.yieldEveryLines ?? DEFAULT_YIELD_LINES);
  }

  /** Accounted identity bytes, not physical retained heap. */
  get bytes(): number {
    return this.retained;
  }

  paths(): string[] {
    return [...this.cache.keys()];
  }

  invalidate(path: string): void {
    this.retained -= this.cache.get(path)?.bytes ?? 0;
    this.cache.delete(path);
    this.negative.delete(path);
  }

  clear(): void {
    this.cache.clear();
    this.negative.clear();
    this.retained = 0;
  }

  /** The index for a stored conversation, or why there is none. Never writes. */
  read(path: string): Promise<SessionIndexResult> {
    const active = this.inflight.get(path);
    if (active) return active;
    const read = this.readWithRetries(path).finally(() => this.inflight.delete(path));
    this.inflight.set(path, read);
    return read;
  }

  async revision(path: string, environmentTag: string): Promise<{ ok: true; index: SessionIndex; revision: string } | { ok: false; failure: SessionIndexFailure }> {
    const result = await this.read(path);
    if (!result.ok) return result;
    return { ok: true, index: result.index, revision: sessionRevisionOf(this.hash, environmentTag, result.index.state) };
  }

  private async readWithRetries(path: string): Promise<SessionIndexResult> {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const result = await this.attempt(path);
      if (result.ok || result.failure.reason !== "changed") return result;
      if (attempt + 1 < RETRIES) await this.retryBackoff(attempt);
    }
    return failure("changed");
  }

  /** Changed-file retries yield and back off, and remain bounded at three. */
  private async retryBackoff(attempt: number): Promise<void> {
    await this.yieldToHost();
    await new Promise<void>((resolve) => setTimeout(resolve, 1 << attempt));
  }

  /** One recency policy for both successful and negative cache hits. */
  private touch<T extends { at: number }>(cache: Map<string, T>, path: string, value: T): T {
    cache.delete(path);
    value.at = this.now();
    cache.set(path, value);
    return value;
  }

  private cachedNegative(path: string, identity: FileIdentity): SessionIndexResult | undefined {
    const cached = this.negative.get(path);
    if (!cached || !sameIdentity(cached, identity)) {
      if (cached) this.negative.delete(path);
      return undefined;
    }
    this.touch(this.negative, path, cached);
    return { ok: false, failure: { ...cached.failure } };
  }

  private rememberNegative(path: string, stats: Stats, result: { ok: false; failure: SessionIndexFailure }): SessionIndexResult {
    if (!NEGATIVE_REASONS.has(result.failure.reason)) return result;
    // A failure and a successful index for the same path must never coexist;
    // scan/read errors may have partially mutated a resumable durable fold.
    this.invalidate(path);
    this.negative.set(path, { ...identityOf(stats), failure: { ...result.failure }, at: this.now() });
    while (this.negative.size > this.sessions) this.negative.delete(this.negative.keys().next().value!);
    return result;
  }

  private async attempt(path: string): Promise<SessionIndexResult> {
    // An unreadable file can still usually be stated. That identity lets the
    // same failure return without another open/read attempt.
    try {
      const pathStats = statSync(path);
      const cached = this.cachedNegative(path, identityOf(pathStats));
      if (cached) return cached;
    } catch {
      // `open` below owns the person-facing missing/unreadable distinction.
    }

    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return failure("missing", code);
      try {
        return this.rememberNegative(path, statSync(path), failure("unreadable", code));
      } catch {
        return failure("unreadable", code);
      }
    }

    let before: Stats | undefined;
    try {
      before = this.stat(fd);
      const negative = this.cachedNegative(path, identityOf(before));
      if (negative) return negative;
      if (!before.isFile()) return failure("not-a-session", "not a file");
      if (before.size === 0) return failure("not-a-session", "empty");
      if (before.size > this.limits.fileBytes) return this.rememberNegative(path, before, failure("too-large", "file"));

      const headerLine = this.readHeaderLine(fd, before.size);
      if (!headerLine) return failure("not-a-session", "no header");
      const header = parseHeader(headerLine.text);
      if (!header) return failure("not-a-session", "header");
      if ((header.version ?? 1) !== READABLE_SESSION_VERSION) {
        return this.rememberNegative(path, before, failure("unsupported-version", String(header.version ?? 1)));
      }
      const headerDigest = this.hash(headerLine.text);

      const resumed = this.resumable(path, before, headerDigest, fd);
      if (resumed?.untouched && resumed.cached.offset === before.size) {
        return { ok: true, index: copyIndex(indexFrom(resumed.cached.header, resumed.cached.durable, identityOf(before))) };
      }
      const durable = resumed?.cached.durable ?? {
        fold: RevisionFold.create(this.hash, header),
        entries: [],
        checkpoints: [],
        checkpointStart: 0,
        bytes: 0,
      };
      const from = resumed?.cached.offset ?? headerLine.end;

      const scan = await this.scan(fd, from, before.size, durable);
      if (!scan.ok) {
        this.invalidate(path);
        return this.rememberNegative(path, before, scan);
      }

      const after = this.stat(fd);
      if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size) {
        this.invalidate(path);
        return failure("changed", "rewritten");
      }
      if (after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) {
        this.invalidate(path);
        return failure("changed", "touched");
      }

      this.store(path, before, {
        headerDigest,
        header,
        offset: scan.offset,
        anchor: this.anchor(fd, headerLine.end, scan.offset),
        durable,
      });
      this.negative.delete(path);

      const index = indexFrom(header, durable, identityOf(before), scan.tail);
      return { ok: true, index: copyIndex(index) };
    } catch (error) {
      const result = failure("unreadable", (error as { code?: string }).code ?? "read failed");
      return before ? this.rememberNegative(path, before, result) : result;
    } finally {
      closeSync(fd);
    }
  }

  private resumable(path: string, stats: Stats, headerDigest: string, fd: number): { cached: Cached; untouched: boolean } | undefined {
    const cached = this.cache.get(path);
    if (!cached) return undefined;
    const same = cached.dev === stats.dev && cached.ino === stats.ino && cached.headerDigest === headerDigest && stats.size >= cached.size;
    const untouched = stats.size === cached.size && stats.mtimeMs === cached.mtimeMs && stats.ctimeMs === cached.ctimeMs;
    // Short-circuiting `untouched` is important: a warm no-op read does not
    // spend another 64 KiB read merely to prove bytes whose full identity did
    // not change.
    const continues = untouched || this.anchor(fd, cached.anchor.start, cached.offset).digest === cached.anchor.digest;
    if (!same || !continues) {
      this.invalidate(path);
      return undefined;
    }
    return { cached: this.touch(this.cache, path, cached), untouched };
  }

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

  private async scan(fd: number, from: number, size: number, durable: Durable): Promise<ScanResult> {
    const buffer = Buffer.alloc(CHUNK);
    let fragments: Buffer[] = [];
    let fragmentBytes = 0;
    let position = from;
    let offset = from;
    let linesSinceYield = 0;

    const fold = (line: Buffer, lineOffset: number): { ok: false; failure: SessionIndexFailure } | undefined => {
      const entry = parseEntry(line.toString("utf8"), lineOffset, line.length);
      if (!entry) return undefined;
      if (durable.entries.length >= this.limits.entries) return failure("too-large", "entries");
      try {
        durable.fold.push(entry.value);
      } catch (error) {
        return failure("uncanonical", error instanceof Error ? error.message : undefined);
      }
      durable.entries.push(entry.identity);
      durable.bytes += entryBytes(entry.identity);
      const checkpoint = { ...durable.fold.state, leafId: entry.identity.id ?? null };
      if (this.limits.checkpoints > 0) {
        if (durable.checkpoints.length < this.limits.checkpoints) durable.checkpoints.push(checkpoint);
        else {
          durable.bytes -= checkpointBytes(durable.checkpoints[durable.checkpointStart]!);
          durable.checkpoints[durable.checkpointStart] = checkpoint;
          durable.checkpointStart = (durable.checkpointStart + 1) % this.limits.checkpoints;
        }
        durable.bytes += checkpointBytes(checkpoint);
      }
      if (durable.bytes > this.limits.indexBytes) return failure("too-large", "index");
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
        const problem = fold(line, offset);
        if (problem) return problem;
        fragments = [];
        fragmentBytes = 0;
        start = newline + 1;
        offset = position - read + start;
        if (++linesSinceYield >= this.yieldEveryLines) {
          linesSinceYield = 0;
          await this.yieldToHost();
        }
      }
      if (start < read) {
        const fragment = Buffer.from(chunk.subarray(start));
        if (fragmentBytes + fragment.length > this.limits.lineBytes) return failure("too-large", "line");
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
    }

    if (fragmentBytes > 0) {
      const entry = parseEntry(Buffer.concat(fragments, fragmentBytes).toString("utf8"), offset, fragmentBytes);
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

  private store(path: string, stats: Stats, parts: Omit<Cached, keyof FileIdentity | "bytes" | "at">): void {
    this.invalidate(path);
    const bytes = parts.durable.bytes;
    const entry: Cached = { ...parts, ...identityOf(stats), bytes, at: this.now() };
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

function indexFrom(header: SessionRevisionHeader, durable: Durable, identity: FileIdentity, tail?: { entry: IndexedEntry; state: RevisionState }): SessionIndex {
  const entries = tail ? [...durable.entries, tail.entry] : durable.entries;
  const state: RevisionState = { ...(tail ? tail.state : durable.fold.state), leafId: entries.at(-1)?.id ?? null };
  const ordered = durable.checkpoints.length === 0 || durable.checkpointStart === 0
    ? durable.checkpoints
    : [...durable.checkpoints.slice(durable.checkpointStart), ...durable.checkpoints.slice(0, durable.checkpointStart)];
  const checkpoints = tail ? [...ordered, { ...tail.state, leafId: tail.entry.id ?? null }] : ordered;
  return { header, entries, leafId: state.leafId, state, checkpoints, identity };
}

function copyIndex(index: SessionIndex): SessionIndex {
  return {
    header: { ...index.header },
    entries: index.entries.map((entry) => ({ ...entry })),
    leafId: index.leafId,
    state: { ...index.state },
    checkpoints: index.checkpoints.map((checkpoint) => ({ ...checkpoint })),
    identity: { ...index.identity },
  };
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
    cwd: header.cwd,
    ...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {}),
    ...(typeof header.version === "number" ? { version: header.version } : {}),
  };
}

function parseEntry(line: string, offset: number, length: number): { value: unknown; identity: IndexedEntry } | undefined {
  if (!line.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = parsed as { type?: unknown } | null;
  if (entry?.type === "session") return undefined;
  return {
    value: parsed,
    identity: { ...historyWindowNode(parsed), offset, length },
  };
}
