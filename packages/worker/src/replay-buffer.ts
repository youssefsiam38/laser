import type { SessionUpdateParams } from "@lasercode/protocol";

/** A FIFO with O(1) front removal and both count and serialized-byte admission.
 * Dropping an oversized update clears its predecessors: replay must always be
 * a contiguous suffix. The live driver and pending questions are not owned here.
 */
export class ReplayBuffer implements Iterable<SessionUpdateParams> {
  private readonly entries = new Map<number, { value: SessionUpdateParams; bytes: number }>();
  private retainedBytes = 0;

  constructor(private readonly limit: number, private readonly byteLimit: number) {}

  get first(): SessionUpdateParams | undefined { return this.entries.values().next().value?.value; }
  get bytes(): number { return this.retainedBytes; }
  get size(): number { return this.entries.size; }

  push(value: SessionUpdateParams): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.entries.set(value.seq, { value, bytes });
    this.retainedBytes += bytes;
    while (this.entries.size > this.limit || this.retainedBytes > this.byteLimit) {
      const first = this.entries.entries().next().value;
      if (!first) break;
      this.entries.delete(first[0]);
      this.retainedBytes -= first[1].bytes;
    }
  }

  *[Symbol.iterator](): Iterator<SessionUpdateParams> {
    for (const { value } of this.entries.values()) yield value;
  }
}
