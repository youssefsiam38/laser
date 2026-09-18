/**
 * The renderer's step 1: caches that can be thrown away and read again (RP-8).
 *
 * Deliberately small, and deliberately explicit. A cache belongs here only when
 * all three are true: nothing on screen is rendered from it, dropping it costs
 * at most a re-read, and it can say exactly what it dropped. Everything else in
 * this window is either state a person would notice losing or memory another
 * slice already owns:
 *
 * - decoded images (`runtime/image-blobs.ts`) keep a bounded residue for rows
 *   that have scrolled off screen, and that residue is exactly this: nothing
 *   renders from it, losing it costs one re-read when the row comes back, and
 *   `releaseIdle()` says how many pictures and how much decoded surface it
 *   gave up. The pool of the environment this window is in registers itself
 *   when it is built (M16-T82); what a row is showing and what a viewer is
 *   holding are never part of what it gives back;
 * - the transcripts themselves are step 2's, through T5's `ViewCache`;
 * - measurement, projection and entry memos are `WeakMap`s: they go with the
 *   objects they describe;
 * - find ranges, viewport heights, drafts, attachments, the device tail cache
 *   and the canonical store are not caches at all.
 *
 * So two kinds of cache register here: the bounded project-file read cache each
 * thread keeps, and the decoded-image residue of the transcript that is open. A
 * window holding neither has nothing to give, and says `nothing_to_give` rather
 * than inventing a number.
 *
 * Ordinary React state is never registered here. If it renders, it is not a
 * cache.
 */

/** What a release actually dropped. Exact, or it is not evidence. */
export interface EphemeralRelease {
  count: number;
  bytes: number;
  /** Caches whose release threw. Counted, never retried, never fatal. */
  failures: number;
}

export interface EphemeralCache {
  /** Drop everything held and say exactly what that was. */
  clear(): { count: number; bytes: number };
}

const caches = new Set<EphemeralCache>();

/** Register a live cache; the returned function forgets it again. */
export function registerEphemeralCache(cache: EphemeralCache): () => void {
  caches.add(cache);
  return () => {
    caches.delete(cache);
  };
}

/**
 * Release every registered cache, once.
 *
 * One cache that throws never stops another: its failure is counted and the
 * pass carries on, because giving memory back must not depend on every holder
 * behaving.
 */
export function releaseEphemeralCaches(): EphemeralRelease {
  let count = 0;
  let bytes = 0;
  let failures = 0;
  for (const cache of [...caches]) {
    try {
      const released = cache.clear();
      if (!Number.isSafeInteger(released.count) || released.count < 0
        || !Number.isSafeInteger(released.bytes) || released.bytes < 0) {
        failures += 1;
        continue;
      }
      count += released.count;
      bytes += released.bytes;
    } catch {
      failures += 1;
    }
  }
  return { count, bytes, failures };
}

/** How many caches are registered right now. For tests and counters only. */
export function ephemeralCacheCount(): number {
  return caches.size;
}
