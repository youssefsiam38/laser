/**
 * What this host is holding for somebody else, in numbers (RP-7 → RP-3).
 *
 * "Queued" means complete frames handed to a transport and not yet settled,
 * plus the captures being reassembled. It is deliberately **not** a count of
 * connections: an idle socket holds nothing, and reporting one per connection
 * made the diagnostic say "something is queued" whenever anybody was attached.
 *
 * A decoder's half-received frame is bytes, not a frame: it is not a message
 * yet, and counting it as one would be a second kind of lie.
 *
 * Numbers only. No path, no method, no command, no model, no identity.
 */
export interface TransportQueueSource {
  /** Complete frames handed over and not yet settled. */
  pendingFrames(): number;
  /** Bytes those frames cost, plus any partial frame being read. */
  queuedBytes(): number;
}

export interface TransportQueues {
  /** Complete frames in flight across every transport this host owns. */
  frames: number;
  /** Bytes held for them, including partial inbound frames. */
  bytes: number;
}

export function collectTransportQueues(sources: Iterable<TransportQueueSource>): TransportQueues {
  let frames = 0;
  let bytes = 0;
  for (const source of sources) {
    frames += source.pendingFrames();
    bytes += source.queuedBytes();
  }
  return { frames, bytes };
}
