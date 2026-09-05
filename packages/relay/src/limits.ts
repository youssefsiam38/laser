/**
 * Per-IP token buckets.
 *
 * Channel CREATION and connection ATTEMPTS are limited separately and that
 * separation is the point: a phone on a flaky train reconnects to the *same*
 * channel dozens of times an hour and must not be throttled, while an attacker
 * trying to squat on channel ids they guessed has to create new ones and gets
 * cut off quickly.
 */

export interface TokenBucketOptions {
  /** Burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerMinute: number;
  /** Forget an idle IP after this long, so the map cannot grow without bound. */
  idleMs?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly perMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.perMs = options.refillPerMinute / 60_000;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Spend one token. False means "over the limit right now". */
  take(key: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.at) * this.perMs);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Seconds until the next token, for a Retry-After that is actually true. */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000));
  }

  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.at < cutoff) this.buckets.delete(key);
    }
  }
}

/**
 * Upgrade attempts over a sliding window, used to decide when the relay is
 * under enough load to start demanding cookies.
 */
export class LoadWindow {
  private readonly stamps: number[] = [];

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(): void {
    const now = this.now();
    this.stamps.push(now);
    this.trim(now);
  }

  get count(): number {
    this.trim(this.now());
    return this.stamps.length;
  }

  private trim(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && this.stamps[0]! < cutoff) this.stamps.shift();
  }
}
