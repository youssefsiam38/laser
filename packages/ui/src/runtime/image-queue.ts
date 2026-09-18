/**
 * What a window decodes first when it cannot decode everything (M16-T82).
 *
 * A conversation can point at more pictures than one window may hold decoded
 * at once. That is a scheduling problem, not a failure: the person's own image
 * goes first, what is on screen next, what is about to be on screen after
 * that, and speculative work last. Nothing here reads or holds bytes — it only
 * decides the order and which resident picture gives its room up first.
 */

/**
 * Why an image is wanted, highest first.
 *
 * `requested` is the one the person clicked; `visible` is actually inside the
 * viewport, not merely mounted; `nearby` is within a conservative lookahead of
 * it; `background` is everything else this window happens to be holding rows
 * for.
 */
export const IMAGE_PRIORITY = { background: 0, nearby: 1, visible: 2, requested: 3 } as const;
export type ImagePriority = (typeof IMAGE_PRIORITY)[keyof typeof IMAGE_PRIORITY];

/** Anything the queue orders: how badly it is wanted, and since when. */
export interface Prioritised {
  priority: ImagePriority;
  /** When it was last visible or asked for. Higher is more recent. */
  stamp: number;
  /** Arrival order, so equal priorities keep the order they were asked in. */
  seq: number;
}

/** On screen, or the person's own click: work that is not speculative. */
export const isActive = (item: Prioritised): boolean => item.priority >= IMAGE_PRIORITY.visible;

/** Most wanted first; among equals, the one asked for first. */
export function byUrgency(a: Prioritised, b: Prioritised): number {
  return b.priority - a.priority || a.seq - b.seq;
}

/**
 * Least recently on screen first: the order a full pool gives room up in.
 * A picture that was never visible sorts before one that was.
 */
export function byStaleness(a: Prioritised, b: Prioritised): number {
  return a.priority - b.priority || a.stamp - b.stamp || a.seq - b.seq;
}

/**
 * A small, cancellable priority queue over named work.
 *
 * It holds no promises and starts nothing by itself: the pool asks it what to
 * run next and what to give up, so a cancelled row simply stops being in it.
 */
export class ImageWorkQueue<T extends Prioritised> {
  private readonly items = new Map<string, T>();
  private counter = 0;

  /** The next arrival order; an item keeps it for as long as it is queued. */
  next(): number {
    return ++this.counter;
  }

  get size(): number {
    return this.items.size;
  }

  set(key: string, item: T): T {
    this.items.set(key, item);
    return item;
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }

  delete(key: string): boolean {
    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  /** Everything matching, most wanted first. */
  urgent(matches: (item: T) => boolean): T[] {
    return [...this.items.values()].filter(matches).sort(byUrgency);
  }

  /** Everything matching, least recently visible first. */
  stalest(matches: (item: T) => boolean): T[] {
    return [...this.items.values()].filter(matches).sort(byStaleness);
  }
}
