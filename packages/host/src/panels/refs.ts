/**
 * RefReader — ranged reads behind `pi/panel/read`.
 *
 * A ref is opaque to the client and a grant on the host: only refs that
 * arrived on a panel (PanelStore) are ever served, so an extension cannot be
 * tricked into opening a file the panel did not name, and a client cannot ask
 * for one either. A grant also records the session its panel arrived on, and a
 * read from another session is refused — the relay makes a client an arbitrary
 * remote peer, so "the panel named it" has to mean "the panel *this* session
 * can see named it". Reads are bounded (PANEL_READ_MAX_BYTES) because a stream
 * can be gigabytes.
 *
 * Offsets are **bytes**, everywhere, in both schemes. A window is aligned to
 * UTF-8 character boundaries before it is decoded (`alignUtf8`), and the
 * adjusted start is reported as `from`, so a follower that appends
 * `from + byteLength(chunk)` stays exact and no seam grows a U+FFFD.
 *
 * Schemes:
 *   file:<absolute path>   the host reads the range from disk
 *   log:<sha256>           the log store's content-addressed payloads
 * Anything else — including `inline:` refs, which live in the client — is
 * refused with a sentence that says what to do instead.
 */
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  alignUtf8,
  ErrorCodes,
  PANEL_READ_MAX_BYTES,
  ProtocolError,
  sliceUtf8,
  type PanelReadResult,
  type Ref,
} from "@piorbit/protocol";
import type { RefGrant } from "./store.js";

export interface RefReaderDeps {
  grantFor(ref: Ref): RefGrant | undefined;
  /** The log store's content lookup, when the host has one. */
  logContent?: ((ref: string, maxBytes?: number) => { text: string; bytes: number }) | undefined;
}

export class RefReader {
  constructor(private readonly deps: RefReaderDeps) {}

  async read(path: string, ref: Ref, from: number, to: number): Promise<PanelReadResult> {
    const grant = this.deps.grantFor(ref);
    if (!grant || grant.path !== path) {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That content is not open in any panel of this session, so the host will not read it. Re-open the panel and try again.",
      );
    }
    const end = Math.min(to, from + PANEL_READ_MAX_BYTES);
    if (ref.startsWith("file:")) return this.readFile(ref, ref.slice("file:".length), from, end, grant.binary);
    if (ref.startsWith("log:")) return this.readLog(ref, ref.slice("log:".length), from, end);
    throw new ProtocolError(
      ErrorCodes.Unsupported,
      `The host cannot read "${scheme(ref)}:" content. Panels may reference files (file:) or log payloads (log:).`,
    );
  }

  private async readFile(ref: Ref, file: string, from: number, to: number, binary: boolean): Promise<PanelReadResult> {
    if (!isAbsolute(file)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "A file ref must carry an absolute path.");
    }
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      throw new ProtocolError(
        ErrorCodes.InvalidParams,
        "That file is gone or unreadable. The extension that produced it may have cleaned up; close the panel.",
      );
    }
    const start = Math.min(from, size);
    const length = Math.max(0, Math.min(to, size) - start);
    let chunk = "";
    // The offset the chunk really begins at: text reads move it forward past a
    // character the previous window already carried.
    let chunkStart = start;
    if (length > 0) {
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        const bytes = buffer.subarray(0, bytesRead);
        if (binary) {
          chunk = bytes.toString("base64");
        } else {
          const aligned = alignUtf8(bytes, start === 0);
          chunkStart = start + aligned.start;
          chunk = bytes.toString("utf8", aligned.start, aligned.end);
        }
      } finally {
        await handle.close();
      }
    }
    return {
      ref,
      from: chunkStart,
      bytes: size,
      chunk,
      encoding: binary ? "base64" : "utf8",
      eof: start + length >= size,
    };
  }

  private readLog(ref: Ref, sha: string, from: number, to: number): PanelReadResult {
    if (!this.deps.logContent) {
      throw new ProtocolError(ErrorCodes.Unsupported, "This host runs without a log store, so log payloads cannot be read.");
    }
    // `maxBytes` is a cheap cap on what the store materialises; the window is
    // then taken in bytes like every other scheme, so a client's `from`/`bytes`
    // bookkeeping means the same thing whichever ref it holds.
    const { text, bytes } = this.deps.logContent(sha, to);
    const slice = sliceUtf8(text, from, to);
    const end = slice.from + Buffer.byteLength(slice.chunk, "utf8");
    return {
      ref,
      from: slice.from,
      bytes: Math.max(bytes, slice.bytes),
      chunk: slice.chunk,
      encoding: "utf8",
      eof: end >= slice.bytes,
    };
  }
}

function scheme(ref: string): string {
  const i = ref.indexOf(":");
  return i === -1 ? "(none)" : ref.slice(0, i);
}
