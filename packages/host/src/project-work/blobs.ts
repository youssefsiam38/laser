/**
 * Content-addressed blobs for project work (M21-T2).
 *
 * A sketch document, a screenshot, a source capture or a token file: bytes
 * that are too big or too opaque to live in a revision body. Each one is
 * stored once per project under its sha256, with its length and media type,
 * and is read back in ranges so nothing ever has to hold a whole one.
 *
 * Bodies above {@link BLOB_CHUNKED_ABOVE} are stored as bounded chunks, each
 * with its own digest, because `node:sqlite` has no incremental blob I/O: a
 * single column cannot be read without materialising all of it. A ranged read
 * therefore steps only the chunks its window touches, and verifies each one
 * before it is used — nothing is ever returned under a digest it does not
 * match.
 */
import { createHash } from "node:crypto";
import { mintBlobId, sha256 } from "./ids.js";
import type { ProjectWorkDatabase } from "./schema.js";

/** Above this a blob is stored as chunks. */
export const BLOB_CHUNKED_ABOVE = 1024 * 1024;
/** One stored chunk. */
export const BLOB_CHUNK_BYTES = 256 * 1024;

export interface StoredBlob {
  blobId: string;
  digest: string;
  mediaType: string;
  bytes: number;
  /** False when this exact content was already stored for this project. */
  inserted: boolean;
}

export interface BlobRange {
  blobId: string;
  digest: string;
  mediaType: string;
  totalBytes: number;
  offset: number;
  bytes: number;
  nextOffset?: number;
  data?: Buffer;
  released?: { reason: "quota" | "retention" | "migration"; detail: string };
  /** Set when the stored bytes do not match what they are addressed by. */
  corrupt?: true;
}

interface BlobRow {
  blob_id: string;
  digest: string;
  media_type: string;
  bytes: number;
  chunked: number;
  data: Uint8Array | null;
  released: string | null;
}

/**
 * Put one blob. Deduplicated by digest within the project, so the same sketch
 * stored twice costs one copy. The caller runs this inside its transaction.
 */
export function putBlob(
  db: ProjectWorkDatabase,
  input: { projectId: string; entityId?: string | undefined; mediaType: string; data: Uint8Array; now: string },
): StoredBlob {
  const digest = sha256(input.data);
  const existing = db.prepare("SELECT blob_id, bytes, media_type FROM blobs WHERE project_id = ? AND digest = ?").get(input.projectId, digest) as
    | { blob_id: string; bytes: number; media_type: string }
    | undefined;
  if (existing) {
    return { blobId: existing.blob_id, digest, mediaType: existing.media_type, bytes: existing.bytes, inserted: false };
  }
  const blobId = mintBlobId();
  const bytes = input.data.byteLength;
  const chunked = bytes > BLOB_CHUNKED_ABOVE;
  db.prepare(
    "INSERT INTO blobs (blob_id, project_id, entity_id, digest, media_type, bytes, chunked, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    blobId,
    input.projectId,
    input.entityId ?? null,
    digest,
    input.mediaType,
    bytes,
    chunked ? 1 : 0,
    chunked ? null : Buffer.from(input.data),
    input.now,
  );
  if (chunked) {
    const insert = db.prepare("INSERT INTO blob_chunks (blob_id, idx, bytes, sha256, data) VALUES (?,?,?,?,?)");
    let index = 0;
    for (let at = 0; at < bytes; at += BLOB_CHUNK_BYTES) {
      const slice = Buffer.from(input.data.subarray(at, Math.min(at + BLOB_CHUNK_BYTES, bytes)));
      insert.run(blobId, index, slice.byteLength, sha256(slice), slice);
      index += 1;
    }
  }
  return { blobId, digest, mediaType: input.mediaType, bytes, inserted: true };
}

/** One page of a blob's bytes, from `offset`, at most `limit` bytes. */
export function readBlobRange(
  db: ProjectWorkDatabase,
  input: { projectId: string; blobId: string; offset: number; limit: number },
): BlobRange | undefined {
  const row = db
    .prepare("SELECT blob_id, digest, media_type, bytes, chunked, data, released FROM blobs WHERE project_id = ? AND blob_id = ?")
    .get(input.projectId, input.blobId) as BlobRow | undefined;
  if (!row) return undefined;
  const base = { blobId: row.blob_id, digest: row.digest, mediaType: row.media_type, totalBytes: row.bytes };
  if (row.released) {
    // Released derived content is labelled, never returned as empty bytes.
    const released = JSON.parse(row.released) as { reason: "quota" | "retention" | "migration"; detail: string };
    return { ...base, offset: 0, bytes: 0, released };
  }
  const offset = Math.min(Math.max(0, input.offset), row.bytes);
  const limit = Math.max(1, input.limit);
  const end = Math.min(row.bytes, offset + limit);
  const data = row.chunked ? readChunks(db, row, offset, end) : readInline(row, offset, end);
  if (!data) return { ...base, offset, bytes: 0, corrupt: true };
  return {
    ...base,
    offset,
    bytes: data.byteLength,
    ...(end < row.bytes ? { nextOffset: end } : {}),
    data,
  };
}

function readInline(row: BlobRow, offset: number, end: number): Buffer | undefined {
  if (!row.data) return undefined;
  const whole = Buffer.from(row.data);
  if (whole.byteLength !== row.bytes || sha256(whole) !== row.digest) return undefined;
  return whole.subarray(offset, end);
}

/**
 * Step exactly the chunks the window touches.
 *
 * Each chunk's position, length and digest are checked before it is used, so a
 * reordered, shortened or altered chunk is a corrupt read rather than plausible
 * bytes. A whole-blob read also checks the join against the blob's own digest:
 * a blob missing its last chunk is made of intact pieces and is still not the
 * blob this row is addressed by.
 */
function readChunks(db: ProjectWorkDatabase, row: BlobRow, offset: number, end: number): Buffer | undefined {
  const rows = db
    .prepare("SELECT idx, bytes, sha256, data FROM blob_chunks WHERE blob_id = ? ORDER BY idx ASC")
    .iterate(row.blob_id) as IterableIterator<{ idx: number; bytes: number; sha256: string; data: Uint8Array }>;
  const pieces: Buffer[] = [];
  const whole = createHash("sha256");
  const wantsWhole = offset === 0 && end === row.bytes;
  let at = 0;
  let expected = 0;
  let corrupt = false;
  try {
    for (const chunk of rows) {
      const data = Buffer.from(chunk.data);
      if (chunk.idx !== expected || data.byteLength !== chunk.bytes || sha256(data) !== chunk.sha256) {
        corrupt = true;
        break;
      }
      expected += 1;
      const chunkStart = at;
      const chunkEnd = at + chunk.bytes;
      at = chunkEnd;
      if (wantsWhole) whole.update(data);
      if (chunkEnd <= offset) continue;
      if (chunkStart >= end) {
        if (!wantsWhole) break;
        continue;
      }
      pieces.push(data.subarray(Math.max(0, offset - chunkStart), Math.min(data.byteLength, end - chunkStart)));
    }
  } finally {
    rows.return?.();
  }
  if (corrupt || expected === 0) return undefined;
  if (wantsWhole && (at !== row.bytes || whole.digest("hex") !== row.digest)) return undefined;
  return Buffer.concat(pieces);
}

/** Total bytes this project's blobs cost. Never touches a blob to count them. */
export function blobBytes(db: ProjectWorkDatabase, projectId: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM blobs WHERE project_id = ?").get(projectId) as { n: number };
  return Number(row.n);
}

/** Drop a blob and its chunks. Used by an explicit delete, never by a budget. */
export function deleteBlob(db: ProjectWorkDatabase, projectId: string, blobId: string): number {
  const row = db.prepare("SELECT bytes FROM blobs WHERE project_id = ? AND blob_id = ?").get(projectId, blobId) as { bytes: number } | undefined;
  if (!row) return 0;
  db.prepare("DELETE FROM blobs WHERE project_id = ? AND blob_id = ?").run(projectId, blobId);
  db.prepare("DELETE FROM blob_chunks WHERE blob_id = ?").run(blobId);
  return row.bytes;
}

/**
 * Release a derived blob's bytes while keeping its row, its size and the
 * reason. Derived content only: nothing canonical is ever released to make
 * room (leap, "Security, privacy and resource rules").
 */
export function releaseBlob(
  db: ProjectWorkDatabase,
  projectId: string,
  blobId: string,
  released: { reason: "quota" | "retention" | "migration"; detail: string },
): number {
  const row = db.prepare("SELECT bytes FROM blobs WHERE project_id = ? AND blob_id = ? AND released IS NULL").get(projectId, blobId) as
    | { bytes: number }
    | undefined;
  if (!row) return 0;
  db.prepare("UPDATE blobs SET data = NULL, released = ? WHERE project_id = ? AND blob_id = ?").run(JSON.stringify(released), projectId, blobId);
  db.prepare("DELETE FROM blob_chunks WHERE blob_id = ?").run(blobId);
  return row.bytes;
}
