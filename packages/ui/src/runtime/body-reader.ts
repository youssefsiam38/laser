/**
 * Reading back what a transcript does not hold (RP-5b).
 *
 * A view keeps a bounded excerpt of a large body and a {@link BodyRef} saying
 * where the rest is. This is the one place that asks for the rest, through
 * `session/entry_range`, a slice at a time, bound to the revision the excerpt
 * was read at.
 *
 * Two shapes, both bounded on purpose:
 *
 * - {@link BodyWindow} pages text. It holds a deque of slices and evicts the
 *   oldest when the window would grow past its aggregate, so paging through a
 *   thirty-megabyte tool result never builds a thirty-megabyte string. There is
 *   no "load everything" path here, on purpose.
 * - {@link ImageBlobs} rebuilds an image outside the JavaScript heap: slices
 *   are decoded into bytes and appended to a `Blob`, and the object URL is
 *   revoked when the image is no longer the one being shown. Bounded by count
 *   and by bytes, oldest first.
 *
 * A refusal is a person-facing sentence, never a stack trace: a conversation
 * that moved on says so and offers the one thing that helps — read it again.
 */
import { ENTRY_RANGE_MAX_BYTES, type ClientRequests } from "@lasercode/protocol";
import type { BodyRef } from "./body-excerpt.js";

export type RangeRequest = (params: ClientRequests["session/entry_range"]["params"]) => Promise<ClientRequests["session/entry_range"]["result"]>;
/** The revision this host is serving for one conversation (RP-9). */
export type RevisionRequest = (path: string) => Promise<string>;

/** Bytes of a body the viewer may hold at once, across every slice. */
export const BODY_VIEWER_AGGREGATE_MAX_BYTES = 256 * 1024;
/** One step of reading. A multiple of four, so a base64 slice decodes alone. */
export const BODY_SLICE_BYTES = 64 * 1024;

export interface BodySlice {
  offset: number;
  bytes: number;
  text: string;
}

export interface BodyWindowState {
  slices: readonly BodySlice[];
  totalBytes: number;
  /** Bytes held across every slice right now. */
  heldBytes: number;
  /** Where reading forward would continue, or `undefined` at the end. */
  next?: number;
  /** Slices dropped to stay inside the aggregate. Said out loud in the UI. */
  evicted: number;
  contentDigest?: string;
}

const EMPTY: BodyWindowState = { slices: [], totalBytes: 0, heldBytes: 0, evicted: 0 };

/**
 * A bounded window over one body. Never more than
 * {@link BODY_VIEWER_AGGREGATE_MAX_BYTES} in hand, whatever the body's size.
 */
export class BodyWindow {
  private state: BodyWindowState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private generation = 0;

  private resolved: string | undefined;

  constructor(
    private readonly request: RangeRequest,
    private readonly path: string,
    private readonly ref: BodyRef & { entryId: string },
    private readonly aggregate = BODY_VIEWER_AGGREGATE_MAX_BYTES,
    private readonly environmentKey = "",
    private readonly revisionOf?: RevisionRequest,
  ) {}

  /**
   * The revision to read at: the one the excerpt was taken at when it has one,
   * otherwise the one the host is serving right now. A body that arrived live
   * carries no revision, and inventing one would be a lie.
   */
  private async revision(): Promise<string> {
    if (this.ref.revision) return this.ref.revision;
    this.resolved ??= this.revisionOf ? await this.revisionOf(this.path) : "";
    return this.resolved;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): BodyWindowState => this.state;

  /** Read one slice at an exact offset, replacing the window. */
  async jump(offset: number): Promise<void> {
    const generation = ++this.generation;
    const result = await this.slice(offset);
    if (generation !== this.generation) return;
    this.publish({
      slices: [{ offset: result.offset, bytes: result.bytes, text: result.text }],
      totalBytes: result.totalBytes,
      heldBytes: result.bytes,
      ...(result.next !== undefined ? { next: result.next } : {}),
      evicted: this.state.slices.length,
      ...(result.contentDigest ? { contentDigest: result.contentDigest } : {}),
    });
  }

  /** Read the next slice, evicting the oldest ones if the window is full. */
  async more(): Promise<void> {
    const from = this.state.slices.length === 0 ? this.ref.excerpt.offset + this.ref.excerpt.bytes : this.state.next;
    if (from === undefined) return;
    const generation = this.generation;
    const result = await this.slice(from);
    if (generation !== this.generation) return;
    const slices = [...this.state.slices, { offset: result.offset, bytes: result.bytes, text: result.text }];
    let held = this.state.heldBytes + result.bytes;
    let evicted = this.state.evicted;
    // Paging forward drops what is furthest behind rather than growing.
    while (held > this.aggregate && slices.length > 1) {
      held -= slices[0]!.bytes;
      slices.shift();
      evicted += 1;
    }
    this.publish({
      slices,
      totalBytes: result.totalBytes,
      heldBytes: held,
      ...(result.next !== undefined ? { next: result.next } : {}),
      evicted,
      ...(result.contentDigest ? { contentDigest: result.contentDigest } : {}),
    });
  }

  /** Forget everything held. Used when the viewer closes. */
  clear(): void {
    this.generation += 1;
    this.publish(EMPTY);
  }

  private async slice(offset: number): Promise<ClientRequests["session/entry_range"]["result"]> {
    return this.request({
      path: this.path,
      environmentKey: this.environmentKey,
      revision: await this.revision(),
      entryId: this.ref.entryId,
      component: this.ref.component,
      offset,
      limit: Math.min(BODY_SLICE_BYTES, ENTRY_RANGE_MAX_BYTES),
    });
  }

  private publish(state: BodyWindowState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * A refusal, in a person's words. Nothing here shows a code or a path.
 */
export function bodyReadMessage(error: unknown): string {
  const code = (error as { code?: number } | null)?.code;
  if (code === -32007) return "This conversation moved on since this message was read. Open it again to see the rest.";
  if (code === -32000) return "This conversation is no longer stored here.";
  return "That part could not be read just now. Try again in a moment.";
}

/**
 * Images, rebuilt outside the JavaScript heap and bounded.
 *
 * Slices of the base64 payload are decoded on arrival and appended to a
 * `Blob`; the transcript holds an object URL, never the bytes. At most
 * {@link IMAGE_BLOB_MAX} images and {@link IMAGE_BLOB_MAX_BYTES} are kept, and
 * the oldest URL is revoked when a newer one arrives.
 */
export const IMAGE_BLOB_MAX = 24;
export const IMAGE_BLOB_MAX_BYTES = 128 * 1024 * 1024;

interface BlobEntry { url: string; bytes: number }

export class ImageBlobs {
  private readonly entries = new Map<string, BlobEntry>();
  private readonly inflight = new Map<string, Promise<string | undefined>>();
  private bytes = 0;

  private readonly revisions = new Map<string, Promise<string>>();

  constructor(private readonly request: RangeRequest, private readonly environmentKey = "", private readonly revisionOf?: RevisionRequest) {}

  private revision(path: string, ref: BodyRef): Promise<string> {
    if (ref.revision) return Promise.resolve(ref.revision);
    let pending = this.revisions.get(path);
    if (!pending) {
      pending = this.revisionOf ? this.revisionOf(path) : Promise.resolve("");
      this.revisions.set(path, pending);
    }
    return pending;
  }

  url(key: string): string | undefined {
    return this.entries.get(key)?.url;
  }

  /** Load one image's bytes into a blob URL, or `undefined` when it cannot be read. */
  load(key: string, path: string, ref: BodyRef & { entryId: string }, mimeType: string): Promise<string | undefined> {
    const held = this.entries.get(key);
    if (held) return Promise.resolve(held.url);
    const active = this.inflight.get(key);
    if (active) return active;
    const work = this.read(path, ref, mimeType).then((url) => {
      this.inflight.delete(key);
      if (url === undefined) return undefined;
      this.keep(key, url.url, url.bytes);
      return url.url;
    }, () => {
      this.inflight.delete(key);
      return undefined;
    });
    this.inflight.set(key, work);
    return work;
  }

  clear(): void {
    for (const entry of this.entries.values()) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.bytes = 0;
  }

  private keep(key: string, url: string, bytes: number): void {
    this.entries.set(key, { url, bytes });
    this.bytes += bytes;
    while (this.entries.size > IMAGE_BLOB_MAX || this.bytes > IMAGE_BLOB_MAX_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done || oldest.value === key) break;
      const entry = this.entries.get(oldest.value)!;
      URL.revokeObjectURL(entry.url);
      this.entries.delete(oldest.value);
      this.bytes -= entry.bytes;
    }
  }

  private async read(path: string, ref: BodyRef & { entryId: string }, mimeType: string): Promise<{ url: string; bytes: number } | undefined> {
    const revision = await this.revision(path, ref);
    const parts: Uint8Array[] = [];
    let offset = 0;
    let bytes = 0;
    for (let slice = 0; slice < Math.ceil(IMAGE_BLOB_MAX_BYTES / BODY_SLICE_BYTES) + 1; slice++) {
      const result = await this.request({
        path,
        environmentKey: this.environmentKey,
        revision,
        entryId: ref.entryId,
        component: ref.component,
        offset,
        // A multiple of four: every slice of a base64 payload decodes alone.
        limit: BODY_SLICE_BYTES,
      });
      const decoded = decodeBase64(result.text);
      if (!decoded) return undefined;
      parts.push(decoded);
      bytes += decoded.byteLength;
      if (bytes > IMAGE_BLOB_MAX_BYTES) return undefined;
      if (result.next === undefined) break;
      offset = result.next;
    }
    const blob = new Blob(parts as BlobPart[], { type: mimeType });
    return { url: URL.createObjectURL(blob), bytes };
  }
}

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}
