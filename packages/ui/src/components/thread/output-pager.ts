/**
 * Continuous reading over one large body, a few slices at a time (M16-T60, D-275).
 *
 * The full-output viewer scrolls a body as one document, but it never holds
 * more of it than a person can be looking at: the segment in view and one
 * neighbour on each side, at most {@link OUTPUT_HELD_MAX} of them. Scrolling
 * away evicts; scrolling back re-reads. Closing the viewer drops everything
 * and fences any read still in flight.
 *
 * Segments are addressed by a fixed nominal grid of {@link OUTPUT_SEGMENT_BYTES}
 * and cut on character boundaries the same way from either side, so two
 * neighbours meet exactly: segment `k` starts at the first character boundary
 * at or after `k × S`, and ends at the first one at or after `(k + 1) × S`.
 * One range reply of {@link ENTRY_RANGE_MAX_BYTES} always reaches past that
 * end, because the grid is eight bytes narrower than a reply (a character is
 * at most four).
 *
 * Every reply is checked exactly as the other readers check theirs
 * (`checkRangeReply`): the entry, the component, the offset, the size and the
 * digests. Nothing here reaches into the runtime's state; it only talks to the
 * range contract.
 */
import { ENTRY_RANGE_MAX_BYTES, utf8ByteLength, type ClientRequests } from "@lasercode/protocol";
import type { BodyRef } from "@/runtime/body-excerpt";
import { bodyReadMessage, BodyReplyRefused, BodyRevisionFence, checkRangeReply, indexOfFolded, type RangeRequest, type RevisionRequest } from "@/runtime/body-reader";

type RangeResult = ClientRequests["session/entry_range"]["result"];

/** The nominal width of one segment: a reply's ceiling less two characters. */
export const OUTPUT_SEGMENT_BYTES = ENTRY_RANGE_MAX_BYTES - 8;
/** The segment in view and one neighbour on each side. */
export const OUTPUT_HELD_MAX = 3;

export interface OutputSegment {
  index: number;
  /** Exact UTF-8 offsets of the segment's first byte and of the byte after its last. */
  start: number;
  end: number;
  text: string;
}

export interface OutputPagerState {
  totalBytes: number;
  segments: ReadonlyMap<number, OutputSegment>;
  /** Segments being read right now. */
  loading: ReadonlySet<number>;
  /** A read failed; in a person's words. Cleared by `retry`. */
  error?: string | undefined;
}

const INVALID_OFFSET = -32602;

export class OutputPager {
  private state: OutputPagerState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private wanted: number[] = [];
  private pumping = false;
  private readonly revisions: BodyRevisionFence;
  private seenTotal: number | undefined;
  private seenDigest: string | undefined;
  private seenAuthority: "live" | "durable" | undefined;
  /** Range requests made, for tests and counters. */
  requests = 0;

  constructor(
    private readonly request: RangeRequest,
    private readonly path: string,
    private readonly ref: BodyRef & { entryId: string },
    private readonly environmentKey = "",
    revisionOf?: RevisionRequest,
  ) {
    this.state = { totalBytes: ref.totalBytes, segments: new Map(), loading: new Set() };
    this.revisions = new BodyRevisionFence(path, ref.revision, ref.contentDigest, revisionOf);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): OutputPagerState => this.state;

  get segmentCount(): number {
    return Math.max(1, Math.ceil(this.state.totalBytes / OUTPUT_SEGMENT_BYTES));
  }

  /** Bytes of text held right now, across every segment. */
  get heldBytes(): number {
    let bytes = 0;
    for (const segment of this.state.segments.values()) bytes += segment.end - segment.start;
    return bytes;
  }

  /** The segment whose nominal range holds this byte. */
  segmentOf(offset: number): number {
    return Math.min(this.segmentCount - 1, Math.max(0, Math.floor(offset / OUTPUT_SEGMENT_BYTES)));
  }

  /**
   * The person is looking at segment `visible`: hold it and its neighbours,
   * let everything else go, and read what is missing — the one in view first.
   */
  show(visible: number): void {
    const last = this.segmentCount - 1;
    const center = Math.min(last, Math.max(0, visible));
    const wanted = [center, center + 1, center - 1].filter(index => index >= 0 && index <= last);
    this.wanted = wanted;
    let changed = false;
    const segments = new Map(this.state.segments);
    for (const index of segments.keys()) {
      if (!wanted.includes(index)) { segments.delete(index); changed = true; }
    }
    if (changed) this.publish({ ...this.state, segments });
    void this.pump();
  }

  retry(): void {
    if (!this.state.error) return;
    this.publish({ ...this.state, error: undefined });
    void this.pump();
  }

  /** Drop everything and fence every read in flight. Says what it dropped. */
  clear(): { count: number; bytes: number } {
    const count = this.state.segments.size;
    const bytes = this.heldBytes;
    this.generation += 1;
    this.wanted = [];
    this.pumping = false;
    this.revisions.reset();
    this.seenTotal = undefined;
    this.seenDigest = undefined;
    this.seenAuthority = undefined;
    this.publish({ totalBytes: this.state.totalBytes, segments: new Map(), loading: new Set() });
    return { count, bytes };
  }

  /**
   * Memory pressure: keep only the segment in view. The neighbours are read
   * again when the person scrolls to them.
   */
  releaseNeighbours(): { count: number; bytes: number } {
    const keep = this.wanted[0];
    let count = 0;
    let bytes = 0;
    const segments = new Map<number, OutputSegment>();
    for (const [index, segment] of this.state.segments) {
      if (index === keep) segments.set(index, segment);
      else { count += 1; bytes += segment.end - segment.start; }
    }
    this.wanted = keep === undefined ? [] : [keep];
    if (count > 0) this.publish({ ...this.state, segments });
    return { count, bytes };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      for (;;) {
        if (generation !== this.generation || this.state.error) return;
        const next = this.wanted.find(index => !this.state.segments.has(index));
        if (next === undefined) return;
        this.publish({ ...this.state, loading: new Set([next]) });
        let segment: OutputSegment;
        try {
          segment = await this.readSegment(next, generation);
        } catch (failure) {
          if (generation !== this.generation) return;
          this.publish({ ...this.state, loading: new Set(), error: bodyReadMessage(failure) });
          return;
        }
        if (generation !== this.generation) return;
        const segments = new Map(this.state.segments);
        // A segment the person scrolled away from while it was being read is
        // not kept: the bound is on what is held, not on what was asked for.
        if (this.wanted.includes(next)) segments.set(next, segment);
        for (const index of segments.keys()) if (!this.wanted.includes(index)) segments.delete(index);
        this.publish({ ...this.state, totalBytes: this.seenTotal ?? this.state.totalBytes, segments, loading: new Set() });
      }
    } finally {
      if (generation === this.generation) this.pumping = false;
    }
  }

  /** One checked reply at an exact offset. */
  private async read(offset: number, generation: number): Promise<RangeResult> {
    const limit = ENTRY_RANGE_MAX_BYTES;
    const checked = await this.revisions.read(async (revision) => {
      this.requests += 1;
      const reply = await this.request({
        path: this.path,
        environmentKey: this.environmentKey,
        revision,
        entryId: this.ref.entryId,
        component: this.ref.component,
        offset,
        limit,
      });
      const current = generation === this.generation;
      return checkRangeReply(reply, {
        revision,
        entryId: this.ref.entryId,
        component: this.ref.component,
        offset,
        limit,
        ...(current && this.seenAuthority ? { authority: this.seenAuthority } : {}),
        totalBytes: current ? (this.seenTotal ?? this.ref.totalBytes) : this.ref.totalBytes,
        contentDigest: current ? (this.seenDigest ?? this.ref.contentDigest) : this.ref.contentDigest,
      });
    }, () => generation === this.generation);
    if (generation === this.generation) {
      this.seenTotal = checked.totalBytes;
      this.seenDigest = checked.contentDigest;
      this.seenAuthority = checked.authority;
    }
    return checked;
  }

  /** The first character boundary at or after `offset`: the authority refuses any other. */
  private async readAligned(offset: number, generation: number): Promise<RangeResult> {
    let failure: unknown;
    for (let step = 0; step <= 3; step++) {
      try {
        return await this.read(offset + step, generation);
      } catch (error) {
        if ((error as { code?: number } | null)?.code !== INVALID_OFFSET) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  private async readSegment(index: number, generation: number): Promise<OutputSegment> {
    const nominal = index * OUTPUT_SEGMENT_BYTES;
    const first = index === 0 ? await this.read(0, generation) : await this.readAligned(nominal, generation);
    const boundary = (index + 1) * OUTPUT_SEGMENT_BYTES;
    let text = first.text;
    let end = first.offset + first.bytes;
    let next = first.next;
    // A reply shorter than its limit before the end of the body: keep reading
    // until the segment's own end is covered, so neighbours never leave a gap.
    while (end < boundary && next !== undefined) {
      if (generation !== this.generation) break;
      const more = await this.read(next, generation);
      if (more.bytes === 0) break;
      text += more.text;
      end = more.offset + more.bytes;
      next = more.next;
    }
    if (end <= boundary) return { index, start: first.offset, end, text };
    const cut = charIndexAtByte(text, first.offset, boundary);
    return { index, start: first.offset, end: cut.byte, text: text.slice(0, cut.index) };
  }

  /**
   * Where `query` next matches at or after `from`, as a byte offset, or
   * `undefined`. One reply and a short overlap are in hand at a time; nothing
   * found is kept.
   */
  async find(query: string, from: number, signal?: { aborted: boolean }): Promise<number | undefined> {
    if (!query) return undefined;
    if (utf8ByteLength(query) > 4 * 1024) {
      throw new BodyReplyRefused("This search is too long to look for in output this size. Try a shorter phrase.");
    }
    const generation = this.generation;
    const total = this.state.totalBytes;
    if (from >= total) return undefined;
    let reply = from === 0 ? await this.read(0, generation) : await this.readAligned(from, generation);
    let carry = "";
    let carryOffset = reply.offset;
    const carryChars = Math.min(Math.max(query.length * 2 + 8, 64), 8 * 1024);
    for (;;) {
      if (signal?.aborted || generation !== this.generation) return undefined;
      const window = carry + reply.text;
      const at = indexOfFolded(window, query);
      if (at >= 0) return carryOffset + utf8ByteLength(window.slice(0, at));
      const keep = Math.min(window.length, carryChars);
      carry = window.slice(window.length - keep);
      carryOffset = reply.offset + reply.bytes - utf8ByteLength(carry);
      if (reply.next === undefined) return undefined;
      reply = await this.read(reply.next, generation);
    }
  }

  private publish(state: OutputPagerState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * The index of the first character in `text` (which starts at byte `start`)
 * whose own first byte is at or after `byte`, and that byte.
 */
export function charIndexAtByte(text: string, start: number, byte: number): { index: number; byte: number } {
  let at = start;
  for (let index = 0; index < text.length; ) {
    if (at >= byte) return { index, byte: at };
    const code = text.charCodeAt(index);
    if (code < 0x80) { at += 1; index += 1; }
    else if (code < 0x800) { at += 2; index += 1; }
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { at += 4; index += 2; } else { at += 3; index += 1; }
    } else { at += 3; index += 1; }
  }
  return { index: text.length, byte: at };
}
