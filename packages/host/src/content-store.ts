/**
 * Where a log row's body actually lives (RP-7).
 *
 * The log store used to own this too, on top of ingestion, retention,
 * correlation and query. Bodies are their own problem: they are the only thing
 * here measured in megabytes, the only thing with an integrity story, and the
 * only thing that needs a schema migration. So they have their own object,
 * with one job — put a body, read part or all of one back, let one go — and
 * one rule: **nothing is ever returned under a digest it does not match.**
 *
 * A body at or below {@link CHUNKED_BODY_ABOVE} is one row. A larger one is
 * bounded chunks, each carrying its own size and digest, because `node:sqlite`
 * has no incremental blob I/O and a single column cannot be written or read
 * without materialising all of it. A read steps the chunks lazily and stops
 * after the budget plus at most the chunk that crosses it.
 */
import { createHash } from "node:crypto";

/** A body above this is stored as bounded chunks. */
export const CHUNKED_BODY_ABOVE = 1024 * 1024;
/** One stored chunk. Small next to any read budget, large enough to be cheap. */
export const CONTENT_CHUNK_BYTES = 256 * 1024;

/**
 * The shape of the body tables this file owns.
 *
 * The number lives beside the tables it describes and is coordinated with the
 * database's own `user_version` by {@link ContentStore.migrate}: this component
 * owns the low half of that value and refuses to touch a database whose version
 * is beyond what it knows, rather than clobbering a future schema.
 */
export const CONTENT_SCHEMA_VERSION = 2;

export interface ContentDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  };
}

export interface StoredBody {
  ref: string;
  bytes: number;
  contentType: "application/json";
  /** False when this exact body was already on disk, so it costs no new bytes. */
  inserted: boolean;
}

/** A body being written a piece at a time. */
export interface BodyStream {
  write: (piece: string) => void;
  /** The row that makes the pieces a body, or `undefined` if they are not one. */
  finish: () => StoredBody | undefined;
  abort: () => void;
}

export interface BodyRead {
  ref: string;
  contentType: string;
  /** Size of the stored body, whatever this read returned. */
  bytes: number;
  truncated: boolean;
  /** Bytes actually returned when `truncated`. */
  truncatedAt?: number;
  text: string;
}

/**
 * Walk a string as bounded UTF-8 pieces, one at a time.
 *
 * A generator, not an array: building every piece first held a second whole
 * copy of the body (and `Buffer.from` a third), which is exactly the kind of
 * duplicate a slice about resource containment must not ship. One chunk is
 * materialised at a time; the caller writes it and lets it go.
 */
export function* utf8Chunks(text: string, chunkBytes: number): Generator<string> {
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    let end = Math.min(offset + chunkBytes, buffer.length);
    while (end > offset && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
    yield buffer.toString("utf8", offset, end);
    offset = end;
  }
}

/** The same split, collected. Kept for callers that really want the list. */
export function splitUtf8(text: string, chunkBytes: number): string[] {
  return [...utf8Chunks(text, chunkBytes)];
}

export class ContentStore {
  private statements = new Map<string, ReturnType<ContentDatabase["prepare"]>>();
  /**
   * True when this file's body tables are a shape this release does not know.
   * Every body operation is then refused: reading one would be reading a shape
   * whose meaning we are guessing at, and writing one would be changing a
   * newer release's data. Rows, sessions and every other part of the store
   * keep working.
   */
  private lockedOut = false;

  constructor(private readonly db: ContentDatabase) {}

  /** Bodies cannot be read or written in this file (see {@link migrate}). */
  get unavailable(): boolean {
    return this.lockedOut;
  }

  /**
   * Bring the body tables to {@link CONTENT_SCHEMA_VERSION}, one atomic step at
   * a time.
   *
   * Each step, and the version bump that records it, happen inside the same
   * transaction: a process that stops between statements leaves the database at
   * the version it was, never half-migrated. A database whose version is higher
   * than this component knows is left alone and reported, because a newer Laser
   * wrote it and this one must not clobber its shape.
   */
  migrate(): { from: number; to: number; ahead: boolean } {
    const from = this.userVersion();
    if (from > CONTENT_SCHEMA_VERSION) {
      this.lockedOut = true;
      return { from, to: from, ahead: true };
    }
    for (let version = from; version < CONTENT_SCHEMA_VERSION; version++) {
      this.transaction(() => {
        this.step(version);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
    return { from, to: this.userVersion(), ahead: false };
  }

  /** One migration step, inside its caller's transaction. */
  private step(from: number): void {
    if (from === 0) {
      // v1: bodies may be chunked. `content.body` stays for small bodies; a
      // chunked row keeps an empty string rather than NULL, so an older binary
      // reading this database sees an empty body instead of throwing.
      const columns = this.db.prepare("PRAGMA table_info(content)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "chunked")) this.db.exec("ALTER TABLE content ADD COLUMN chunked INTEGER");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content_chunks (
          ref    TEXT    NOT NULL,
          idx    INTEGER NOT NULL,
          bytes  INTEGER NOT NULL,
          body   TEXT    NOT NULL,
          PRIMARY KEY (ref, idx)
        );
      `);
      return;
    }
    if (from === 1) {
      // v2: every chunk carries its own digest, so a read can prove what it
      // hands back. Chunked bodies are new in this release and nothing has
      // shipped the interim shape, so a store that has one gives those bodies
      // up rather than carrying a second shape forever; their rows then read
      // as bodies retention no longer keeps.
      const columns = this.db.prepare("PRAGMA table_info(content_chunks)").all() as { name: string }[];
      if (columns.length > 0 && !columns.some((column) => column.name === "sha256")) {
        this.db.exec("DELETE FROM content WHERE ref IN (SELECT DISTINCT ref FROM content_chunks)");
        this.db.exec("DROP TABLE content_chunks");
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content_chunks (
          ref    TEXT    NOT NULL,
          idx    INTEGER NOT NULL,
          bytes  INTEGER NOT NULL,
          sha256 TEXT    NOT NULL,
          body   TEXT    NOT NULL,
          PRIMARY KEY (ref, idx)
        );
      `);
      return;
    }
  }

  private userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    return typeof value === "number" ? value : 0;
  }

  /**
   * Put one already-serialized, already-redacted body on disk, once.
   *
   * Content is addressed by SHA-256, so a retried request costs one copy. A
   * large body's row and all of its chunks are written in one transaction:
   * a failure leaves neither.
   */
  put(body: string, knownBytes?: number, knownRef?: string): StoredBody | undefined {
    if (this.lockedOut) return undefined;
    const bytes = knownBytes ?? Buffer.byteLength(body, "utf8");
    const ref = knownRef ?? createHash("sha256").update(body).digest("hex");
    const chunked = bytes > CHUNKED_BODY_ABOVE;
    let inserted = false;
    this.transaction(() => {
      const stored = this
        .statement("INSERT OR IGNORE INTO content (ref, bytes, content_type, body, chunked) VALUES (?,?,?,?,?)")
        .run(ref, bytes, "application/json", chunked ? "" : body, chunked ? 1 : null);
      inserted = Number(stored.changes) > 0;
      if (!inserted || !chunked) return;
      const insert = this.statement("INSERT OR IGNORE INTO content_chunks (ref, idx, bytes, sha256, body) VALUES (?,?,?,?,?)");
      let index = 0;
      for (const chunk of utf8Chunks(body, CONTENT_CHUNK_BYTES)) {
        insert.run(ref, index, Buffer.byteLength(chunk, "utf8"), createHash("sha256").update(chunk).digest("hex"), chunk);
        index += 1;
      }
    });
    if (inserted && chunked) this.releasePages();
    return { ref, bytes, contentType: "application/json", inserted };
  }

  /**
   * Give back what writing a large body cost SQLite.
   *
   * A chunked body is dozens of pages of WAL and page cache; without this they
   * accumulate across an ingestion burst and the process's resident memory
   * grows with the *rate* of captures rather than with what is retained. A
   * passive checkpoint never waits for a reader, and `shrink_memory` releases
   * the cache SQLite is holding for its own convenience. Both are bounded and
   * neither blocks anything else: a failure here is not worth a row.
   */
  private releasePages(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      this.db.exec("PRAGMA shrink_memory");
    } catch {
      /* a busy reader defers the checkpoint; the next write tries again */
    }
  }

  /**
   * Read a body, or the first `maxBytes` of one.
   *
   * `undefined` means the store has no such body. `{ corrupt: true }` means it
   * has one that cannot be trusted: a chunk that was altered, reordered,
   * shortened or lost. Neither is ever answered with content.
   */
  read(ref: string, maxBytes: number): (BodyRead & { corrupt?: false }) | { corrupt: true; bytes: number } | undefined {
    if (this.lockedOut) return undefined;
    const row = this.db.prepare("SELECT ref, bytes, content_type, body, chunked FROM content WHERE ref = ?").get(ref) as
      | { ref: string; bytes: number; content_type: string; body: string; chunked: number | null }
      | undefined;
    if (!row) return undefined;
    if (row.chunked) {
      const read = this.readChunked(ref, maxBytes, row.bytes);
      if (!read) return { corrupt: true, bytes: row.bytes };
      return {
        ref: row.ref,
        contentType: row.content_type,
        bytes: row.bytes,
        truncated: read.truncated,
        ...(read.truncated ? { truncatedAt: Buffer.byteLength(read.text, "utf8") } : {}),
        text: read.text,
      };
    }
    // `maxBytes` is a byte budget, so it is measured in bytes: a string index
    // let three times that much UTF-8 through for non-Latin text, and cutting
    // mid-code-point would hand the UI a replacement character.
    const bodyBytes = Buffer.byteLength(row.body, "utf8");
    const truncated = bodyBytes > maxBytes;
    const text = truncated ? truncateUtf8(row.body, maxBytes) : row.body;
    return {
      ref: row.ref,
      contentType: row.content_type,
      bytes: row.bytes,
      truncated,
      ...(truncated ? { truncatedAt: Buffer.byteLength(text, "utf8") } : {}),
      text,
    };
  }

  /**
   * Step a chunked body, validating everything it hands back.
   *
   * At most the requested budget plus the one chunk that crosses it is ever in
   * this process. Each chunk's position, exact UTF-8 size and own digest are
   * checked before it is used, and a complete read is also checked as a whole
   * against the row's digest and size — a body missing its last chunk is made
   * of intact pieces and is still not the body this row is addressed by.
   */
  private readChunked(ref: string, maxBytes: number, totalBytes: number): { text: string; truncated: boolean } | undefined {
    const rows = this
      .statement("SELECT idx, bytes, sha256, body FROM content_chunks WHERE ref = ? ORDER BY idx ASC")
      .iterate(ref) as IterableIterator<{ idx: number; bytes: number; sha256: string; body: string }>;
    const pieces: string[] = [];
    const whole = createHash("sha256");
    let taken = 0;
    let truncated = false;
    let expected = 0;
    let corrupt = false;
    try {
      for (const chunk of rows) {
        if (chunk.idx !== expected || Buffer.byteLength(chunk.body, "utf8") !== chunk.bytes) {
          corrupt = true;
          break;
        }
        if (createHash("sha256").update(chunk.body).digest("hex") !== chunk.sha256) {
          corrupt = true;
          break;
        }
        expected += 1;
        if (taken + chunk.bytes > maxBytes) {
          if (taken < maxBytes) pieces.push(truncateUtf8(chunk.body, maxBytes - taken));
          truncated = true;
          break;
        }
        pieces.push(chunk.body);
        whole.update(chunk.body);
        taken += chunk.bytes;
      }
    } finally {
      // Stop the statement where it stands; a half-stepped iterator would hold
      // the read open for as long as the store lives.
      rows.return?.();
    }
    if (corrupt || expected === 0) return undefined;
    if (!truncated && (taken !== totalBytes || whole.digest("hex") !== ref)) return undefined;
    return { text: pieces.join(""), truncated };
  }

  /** How many bytes this body costs, or 0 when it is not stored. */
  sizeOf(ref: string): number {
    if (this.lockedOut) return 0;
    const row = this.statement("SELECT bytes FROM content WHERE ref = ?").get(ref) as { bytes: number } | undefined;
    return row ? row.bytes : 0;
  }

  /**
   * Let a body go, unless a retained entry still points at it. Content is
   * shared by digest, so a retried request must not lose its payload because
   * an older twin aged out. Chunks go with their row, in one transaction.
   */
  release(ref: string): boolean {
    if (this.lockedOut) return false;
    let dropped = 0;
    this.transaction(() => {
      dropped = Number(
        this.statement(
          `DELETE FROM content WHERE ref = ?
             AND NOT EXISTS (SELECT 1 FROM entries WHERE detail_ref = ? AND body_released IS NULL)`,
        ).run(ref, ref).changes,
      );
      if (dropped > 0) this.statement("DELETE FROM content_chunks WHERE ref = ?").run(ref);
    });
    return dropped > 0;
  }

  /** True when this body is on disk right now. */
  has(ref: string): boolean {
    if (this.lockedOut) return false;
    return this.statement("SELECT 1 AS present FROM content WHERE ref = ?").get(ref) !== undefined;
  }

  /** A bounded sweep of bodies no row points at. Returns how many went. */
  collectOrphans(limit: number): number {
    if (this.lockedOut) return 0;
    return Number(
      this.statement(
        `DELETE FROM content WHERE ref IN (
           SELECT ref FROM content WHERE NOT EXISTS (SELECT 1 FROM entries WHERE detail_ref = content.ref) LIMIT ?
         )`,
      ).run(limit).changes,
    );
  }

  /** Every body nothing points at, and every chunk whose row is gone. */
  collectAllOrphans(): void {
    if (this.lockedOut) return;
    this.db.exec("DELETE FROM content WHERE ref NOT IN (SELECT detail_ref FROM entries WHERE detail_ref IS NOT NULL)");
    this.db.exec("DELETE FROM content_chunks WHERE ref NOT IN (SELECT ref FROM content)");
  }

  /** Bytes of every stored body. Never touches a body to count them. */
  totalBytes(): number {
    if (this.lockedOut) return 0;
    try {
      return Number((this.db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM content").get() as { n: number }).n);
    } catch {
      return 0;
    }
  }

  /**
   * Store a body that already arrived as bounded pieces.
   *
   * The pieces a capture was sent in are exactly the shape this store keeps,
   * so joining them into one string only to cut them up again held two more
   * copies of a multi-megabyte body for no purpose. This writes them as they
   * are: the caller keeps its pieces, and nothing else materialises the whole.
   */
  putPieces(pieces: readonly string[], bytes: number, ref: string): StoredBody | undefined {
    if (this.lockedOut) return undefined;
    const chunked = bytes > CHUNKED_BODY_ABOVE;
    if (!chunked) return this.put(pieces.join(""), bytes, ref);
    let inserted = false;
    this.transaction(() => {
      const stored = this
        .statement("INSERT OR IGNORE INTO content (ref, bytes, content_type, body, chunked) VALUES (?,?,?,?,?)")
        .run(ref, bytes, "application/json", "", 1);
      inserted = Number(stored.changes) > 0;
      if (!inserted) return;
      const insert = this.statement("INSERT OR IGNORE INTO content_chunks (ref, idx, bytes, sha256, body) VALUES (?,?,?,?,?)");
      pieces.forEach((piece, index) => {
        insert.run(ref, index, Buffer.byteLength(piece, "utf8"), createHash("sha256").update(piece).digest("hex"), piece);
      });
    });
    if (inserted) this.releasePages();
    return { ref, bytes, contentType: "application/json", inserted };
  }

  /**
   * Take a body's pieces as they arrive, and keep none of them in memory.
   *
   * The host used to hold every piece of a capture until the last one landed,
   * so a 12 MiB request was 12 MiB of this process for as long as it was
   * arriving. Each piece is written as it comes and then let go; the digest is
   * taken as they pass. `finish` writes the row that makes them a body, or
   * `abort` removes what was written.
   */
  openStream(ref: string): BodyStream {
    const digest = createHash("sha256");
    const insert = this.lockedOut
      ? undefined
      : this.statement("INSERT OR IGNORE INTO content_chunks (ref, idx, bytes, sha256, body) VALUES (?,?,?,?,?)");
    let index = 0;
    let bytes = 0;
    let done = false;
    return {
      write: (piece: string) => {
        if (done || !insert) return;
        const size = Buffer.byteLength(piece, "utf8");
        insert.run(ref, index, size, createHash("sha256").update(piece).digest("hex"), piece);
        digest.update(piece);
        index += 1;
        bytes += size;
      },
      finish: () => {
        if (done || !insert) return undefined;
        done = true;
        if (digest.copy().digest("hex") !== ref) {
          this.dropChunks(ref);
          return undefined;
        }
        let inserted = false;
        this.transaction(() => {
          const stored = this
            .statement("INSERT OR IGNORE INTO content (ref, bytes, content_type, body, chunked) VALUES (?,?,?,?,?)")
            .run(ref, bytes, "application/json", "", 1);
          inserted = Number(stored.changes) > 0;
        });
        if (!inserted) this.dropChunks(ref);
        else this.releasePages();
        return { ref, bytes, contentType: "application/json", inserted };
      },
      abort: () => {
        if (done) return;
        done = true;
        this.dropChunks(ref);
      },
    };
  }

  /** Remove pieces written for a body that never became one. */
  private dropChunks(ref: string): void {
    if (this.lockedOut) return;
    try {
      this.statement("DELETE FROM content_chunks WHERE ref = ? AND NOT EXISTS (SELECT 1 FROM content WHERE ref = ?)").run(ref, ref);
    } catch {
      /* the orphan sweep collects anything this could not */
    }
  }

  /** One statement group, or none of it. */
  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* the transaction was already gone; the original failure is the one that matters */
      }
      throw error;
    }
  }

  private statement(sql: string): ReturnType<ContentDatabase["prepare"]> {
    let statement = this.statements.get(sql);
    if (statement) return statement;
    statement = this.db.prepare(sql);
    if (this.statements.size >= 16) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }

  /** Drop cached statements; the database is closing or being replaced. */
  dispose(): void {
    this.statements = new Map();
  }
}

/** Cut a string to at most `maxBytes` UTF-8 bytes, never mid-character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.toString("utf8", 0, end);
}
