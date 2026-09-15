/**
 * The device tail cache, assembled (RP-10).
 *
 * This file is deliberately thin: the decisions live in four modules with one
 * responsibility each, because the races this cache had were consequences of
 * several lifecycles sharing ad-hoc maps.
 *
 * | Module | Owns |
 * | --- | --- |
 * | `lifecycle.ts` | the state machine, the pass token, bounded preparation, the only `publish` |
 * | `mutations.ts` | one serialized queue for writes, touches, deletions, eviction and clearing |
 * | `admission.ts` | what may be written, and what a stored row is allowed to be — pure |
 * | `recency.ts` | one bounded index for what is held, what is hot and what is next to go |
 *
 * The public surface is session-id-first. A session **path** is a private
 * filesystem locator: it is not a key, not an index, not a row field, not part
 * of the additional authenticated data, and not in the payload. The app already
 * knows which conversation it is looking at and resolves that to the session's
 * own opaque id from canonical state (RP-11's handoff).
 */
import type { EnvironmentDescriptor } from "@lasercode/protocol";
import type { ViewTailDto } from "../view-tail.js";
import { fitRelease, readableAge } from "./admission.js";
import type { DeviceCacheCounters } from "./counters.js";
import { createLifecycle, type Lifecycle, type LifecycleDeps, type TailCacheState } from "./lifecycle.js";
import type { TailRecord } from "./record.js";

export type { TailCacheState } from "./lifecycle.js";

export interface TailCacheDeps extends LifecycleDeps {
  /** How long one queued mutation may take, in total (default: the pass budget). */
  budgetMs?: number | undefined;
  /** Deferred work: a write never runs on the path that released a transcript. */
  defer(task: () => void): void;
}

export interface TailCache {
  state(): TailCacheState;
  subscribe(listener: (state: TailCacheState) => void): () => void;
  /**
   * Prepare this environment's cache, bounded. Resolves with the state the
   * connection may open under; never rejects, never waits unbounded.
   */
  prepare(descriptor: EnvironmentDescriptor, budgetMs?: number): Promise<TailCacheState>;
  /** The connection stopped waiting, or the environment went away. */
  deactivate(): void;
  /** RP-5's sink. Never throws, never awaits, never retains the DTO. */
  release(tail: ViewTailDto): void;
  /** RP-11: synchronous, hot-set only, allocation-free on a hit. */
  peek(target: { sessionId: string }): TailRecord | undefined;
  /** RP-11: promote records into the hot set for a later `peek`. Bounded. */
  prime(sessionIds: readonly string[]): Promise<void>;
  /** A record RP-11 has replaced stops being a candidate. */
  supersede(sessionId: string, revision: string): void;
  /** A conversation the person deleted loses its tail: awaited and proved. */
  forget(target: { sessionId: string }): Promise<boolean>;
  /** The person's own clear, and the environment-reset path. */
  clear(scope: "environment" | "all"): Promise<boolean>;
  counters(): DeviceCacheCounters;
}

export function createTailCache(deps: TailCacheDeps): TailCache {
  const lifecycle: Lifecycle = createLifecycle(deps);

  return {
    state: () => lifecycle.state(),
    subscribe: (listener) => lifecycle.subscribe(listener),
    prepare: (descriptor, budgetMs) => lifecycle.prepare(descriptor, budgetMs),
    counters: () => lifecycle.counters(),

    deactivate() {
      lifecycle.cancel();
    },

    release(tail) {
      const live = lifecycle.open();
      if (!live) return;
      const fitted = fitRelease(tail, live.environmentKey, live.bounds);
      if ("refusal" in fitted) {
        // Anything this build cannot fully account for is not a cache entry:
        // storing it would file a guess as a conversation. A tail that is not
        // ours at all is silence; one we understood and could not keep is
        // counted.
        if (fitted.refusal !== "not-a-tail" && fitted.refusal !== "foreign") live.mutations.noteRefusedWrite();
        return;
      }
      // A newer record is never replaced by an older one — and the comparison
      // is against every record this device **holds**, not only the ones whose
      // objects are still in memory: a newer cold row must not be overwritten
      // just because it was not warm. Within one engine generation `seq` orders
      // two captures; across generations only the capture time can, because
      // `seq` restarts (D-g).
      const existing = live.recency.held(fitted.sessionId);
      if (existing) {
        const newer = existing.epoch === fitted.payload.epoch
          ? existing.seq > fitted.payload.seq
          : Date.parse(existing.capturedAt) > Date.parse(fitted.capturedAt);
        if (newer) return;
      }
      // The write itself never runs on the path that released the transcript.
      deps.defer(() => {
        const still = lifecycle.open();
        if (!still || still.pass !== live.pass) return;
        still.mutations.write({
          sessionId: fitted.sessionId,
          payload: fitted.payload,
          text: fitted.text,
          bytes: fitted.bytes,
          capturedAt: fitted.capturedAt,
        });
      });
    },

    peek(target) {
      const live = lifecycle.open();
      if (!live) return undefined;
      const record = live.recency.hot(target.sessionId);
      if (!record) return undefined;
      if (readableAge(record.capturedAt, deps.now(), live.bounds.ageMs) === undefined) {
        // Expired while it was held: it stops being readable **and** its row is
        // removed, proved, by the one owner that deletes anything.
        live.recency.cool(target.sessionId);
        void live.mutations.purgeExpired();
        return undefined;
      }
      // Recency lives outside the frozen record, so a hit allocates nothing.
      // The watermark is read before the use is marked, so a durable write
      // that does not commit can put it back.
      const previous = {
        usedAt: live.recency.usedAt(target.sessionId),
        persistedAt: live.recency.persistedAt(target.sessionId),
      };
      if (live.recency.touch(target.sessionId, deps.now())) live.mutations.touch(target.sessionId, previous);
      return record;
    },

    async prime(sessionIds) {
      const live = lifecycle.open();
      if (!live) return;
      await live.mutations.promote(sessionIds);
    },

    supersede(sessionId, revision) {
      const live = lifecycle.open();
      if (!live) return;
      const held = live.recency.held(sessionId);
      if (!held || held.revision === revision) return;
      // Superseded, so it stops being a candidate **now** — synchronously, off
      // the paint path — and its row is deleted and proved by the one owner
      // that deletes anything. The session is not tombstoned for good: a later,
      // fresh release of the same conversation is accepted as usual.
      live.recency.forget(sessionId);
      void live.mutations.supersede(sessionId, held.revision);
    },

    async forget(target) {
      const live = lifecycle.open();
      if (!live) return true;
      return live.mutations.forget(target.sessionId);
    },

    async clear(scope) {
      if (scope === "all") {
        // The tracked whole-database path: it needs no open store, which is
        // what makes it the recovery a refused cache can actually offer.
        const live = lifecycle.open();
        if (live) await live.mutations.clearEnvironment().catch(() => false);
        return lifecycle.destroyEverything(live?.pass);
      }
      const live = lifecycle.open();
      if (!live) return false;
      const cleared = await live.mutations.clearEnvironment();
      if (cleared) lifecycle.markCleared();
      return cleared;
    },
  };
}
