/**
 * Everything that changes this device, in one order (RP-10).
 *
 * Writes, durable touches, session deletions, eviction and clearing used to run
 * as independent promise chains, which is how a proved deletion could be
 * resurrected by a write that had been accepted before it and committed after.
 * They are now one queue with two lanes:
 *
 * - the **work** lane carries writes and touches. It is the only thing that is
 *   ever shed or coalesced, and shedding is counted;
 * - the **control** lane carries `forget`, `clear` and `purge`. It is never
 *   dropped, never reordered behind a later write, and never starved: control
 *   has reserved capacity, and a control op dequeues ahead of any work queued
 *   after it.
 *
 * Two synchronous effects make that safe rather than merely orderly:
 *
 * - `forget` **tombstones** its session the moment it is admitted, so a write
 *   already queued for that session is dropped when it dequeues, whatever the
 *   depth of the queue;
 * - `clear` marks the pass **non-writing** the moment it is admitted, so every
 *   queued write and touch is dropped and no new one is accepted.
 *
 * Every deletion here is bounded (rows), deadlined and **proved**; a deletion
 * that cannot be proved is a fault, and the lifecycle closes the cache on it.
 */
import { TAIL_RECORD_SCHEMA, TAIL_SCAN_LIMITS, type TailBounds } from "./bounds.js";
import { openPayload, parseStoredRow, readableAge, storedBytesOf, type ValidatedRow } from "./admission.js";
import {
  TAIL_PAYLOAD_VERSION,
  checksumOf,
  contentText,
  identityAad,
  type TailKey,
  type TailPayload,
  type TailRecord,
} from "./record.js";
import type { RecencyIndex } from "./recency.js";
import type { TailRow, TailStore } from "./store.js";
import type { TailVault } from "./vault.js";

/** Queue ceilings. Writes and touches are shed; control never is. */
export const QUEUE_LIMITS = {
  /** Accepted writes waiting to commit. */
  writes: 16,
  /** Accepted write payload bytes waiting to commit (each is ≤ 256 KiB). */
  writeBytes: 1024 * 1024,
  /** One coalesced touch per session at most. */
  touches: 24,
  /** Reserved control capacity: one per session plus clear/purge headroom. */
  control: 28,
} as const;

export type MutationFault = "purge" | "storage";

export interface WriteRequest {
  readonly sessionId: string;
  readonly payload: TailPayload;
  readonly text: string;
  readonly bytes: number;
  readonly capturedAt: string;
}

export interface MutationDeps {
  store: TailStore;
  vault: TailVault;
  recency: RecencyIndex;
  bounds: TailBounds;
  environmentKey: string;
  appVersion: string;
  now(): number;
  /** The pass this owner belongs to. A dead pass runs nothing. */
  live(): boolean;
  /** A deletion that could not be proved, or storage that gave up. */
  onFault(fault: MutationFault): void;
  /** A write that was shed, refused or could not be sealed. */
  onWriteRefused(): void;
  onEvicted(count: number): void;
}

export interface MutationOwner {
  /**
   * Promote stored records into the hot set for a later `peek`.
   *
   * Runs here rather than in the façade because it needs the store, the vault
   * and the one owner that is allowed to delete: a row this build cannot read
   * is removed — awaited and proved — rather than left to poison every later
   * pass, and a partial scan promotes nothing at all.
   */
  promote(sessionIds: readonly string[]): Promise<boolean>;
  /** A release this build refused before it ever reached the queue. */
  noteRefusedWrite(): void;
  /** Accept a fitted release. Returns false when the work lane shed it. */
  write(request: WriteRequest): boolean;
  /**
   * Persist a use, coalesced, off the read path.
   *
   * `persistedBefore` is the watermark to restore if the write does not commit:
   * this device must never claim recency it did not write.
   */
  touch(sessionId: string, persistedBefore: number): void;
  /** Tombstone a session, then delete and prove it. */
  forget(sessionId: string): Promise<boolean>;
  /** Stop writing, drain what was accepted, then delete this environment. */
  clearEnvironment(): Promise<boolean>;
  /** Remove expired rows, bounded and proved. */
  purgeExpired(): Promise<boolean>;
  /** Everything accepted so far has settled. */
  drain(): Promise<void>;
  /** Queue depth, for the counters. */
  depth(): { writes: number; touches: number; control: number };
  /** No more work is accepted (the pass is over). */
  seal(): void;
}

type Op =
  | { kind: "write"; sessionId: string; request: WriteRequest }
  | { kind: "touch"; sessionId: string; persistedBefore: number }
  | { kind: "forget"; sessionId: string }
  | { kind: "clear" }
  | { kind: "purge" }
  | { kind: "promote" };

/** One coalesced control op and everybody waiting for its answer. */
interface Waiters {
  readonly settle: Array<(ok: boolean) => void>;
}

export function createMutationOwner(deps: MutationDeps): MutationOwner {
  const work: Op[] = [];
  const control: Op[] = [];
  /**
   * Who is waiting for which control op.
   *
   * Coalesced by identity — one entry per session for `forget`, one for
   * `clear`, one for `purge`, one for `promote` — so the control lane is
   * *statically* bounded (sessions + 3) however often a person or a surface
   * asks, and nothing is ever dropped or run twice.
   */
  const forgetWaiters = new Map<string, Waiters>();
  let clearWaiters: Waiters | undefined;
  let purgeWaiters: Waiters | undefined;
  let promoteWaiters: Waiters | undefined;
  let promoteWanted = new Set<string>();
  const tombstoned = new Set<string>();
  const pendingTouch = new Set<string>();
  let writeBytes = 0;
  let writing = false;
  let sealed = false;
  let nonWriting = false;
  let idle: Array<() => void> = [];

  const key = (sessionId: string): TailKey => [deps.environmentKey, sessionId];
  const deadline = (): number => deps.now() + TAIL_SCAN_LIMITS.prepareMs;
  const removeBounds = () => ({ rows: TAIL_SCAN_LIMITS.deleteRows, deadline: deadline() });

  const answer = (waiters: Waiters | undefined, ok: boolean): void => {
    for (const settle of waiters?.settle ?? []) settle(ok);
  };

  /** A tombstone is kept only while a write for that session could still run. */
  const releaseTombstone = (sessionId: string): void => {
    if (work.some((op) => op.kind === "write" && op.sessionId === sessionId)) return;
    tombstoned.delete(sessionId);
  };

  const settleIdle = (): void => {
    if (work.length > 0 || control.length > 0 || writing) return;
    // Nothing is queued, so no tombstone is protecting anything any more.
    for (const sessionId of [...tombstoned]) releaseTombstone(sessionId);
    const waiting = idle;
    idle = [];
    for (const resolve of waiting) resolve();
  };

  const pump = (): void => {
    if (writing) return;
    void run();
  };

  const next = (): Op | undefined => control.shift() ?? work.shift();

  async function run(): Promise<void> {
    writing = true;
    try {
      for (;;) {
        const op = next();
        if (!op) break;
        if (op.kind === "write") {
          writeBytes -= op.request.bytes;
          // Dropped rather than committed: this session has been deleted, or
          // the environment is being cleared. Either way the bytes must not
          // come back.
          if (!deps.live() || nonWriting || tombstoned.has(op.sessionId)) continue;
          await commit(op.request);
          continue;
        }
        if (op.kind === "touch") {
          pendingTouch.delete(op.sessionId);
          if (!deps.live() || nonWriting || tombstoned.has(op.sessionId)) continue;
          await persistTouch(op.sessionId, op.persistedBefore);
          continue;
        }
        if (op.kind === "forget") {
          const waiters = forgetWaiters.get(op.sessionId);
          forgetWaiters.delete(op.sessionId);
          const ok = await deleteSessions([op.sessionId]);
          // The tombstone outlives the deletion only for as long as a write for
          // that session could still be queued behind it.
          releaseTombstone(op.sessionId);
          answer(waiters, ok);
          continue;
        }
        if (op.kind === "purge") {
          const waiters = purgeWaiters;
          purgeWaiters = undefined;
          answer(waiters, await purge());
          continue;
        }
        if (op.kind === "promote") {
          const waiters = promoteWaiters;
          const wanted = promoteWanted;
          promoteWaiters = undefined;
          promoteWanted = new Set();
          answer(waiters, await promotePass(wanted));
          continue;
        }
        const waiters = clearWaiters;
        clearWaiters = undefined;
        answer(waiters, await clearAll());
      }
    } finally {
      writing = false;
      settleIdle();
    }
  }

  /** Bring the environment inside its bounds; false when it cannot be proved. */
  async function evict(options: { keep: string; incoming?: { sessionId: string; bytes: number } | undefined; minimum?: number | undefined }): Promise<boolean> {
    if (!(await purge())) return false;
    const plan = deps.recency.plan({
      bounds: deps.bounds,
      keep: options.keep,
      ...(options.incoming ? { incoming: options.incoming } : {}),
      ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
      max: TAIL_SCAN_LIMITS.deleteRows,
    });
    if (!plan.fits) return false;
    if (plan.doomed.length === 0) return true;
    const removed = await deps.store.remove(plan.doomed.map(key), TAIL_SCAN_LIMITS.batchRows, removeBounds());
    if (!removed) return false;
    for (const sessionId of plan.doomed) deps.recency.forget(sessionId);
    deps.onEvicted(plan.doomed.length);
    return true;
  }

  /** Expired rows go first, in every bounded pass that touches the store. */
  async function purge(): Promise<boolean> {
    const gone = deps.recency.expired(deps.now(), deps.bounds.ageMs);
    if (gone.length === 0) return true;
    const removed = await deps.store.remove(
      gone.map((row) => key(row.sessionId)),
      TAIL_SCAN_LIMITS.batchRows,
      removeBounds(),
    );
    if (!removed) return false;
    for (const row of gone) deps.recency.forget(row.sessionId);
    return true;
  }

  async function commit(request: WriteRequest): Promise<void> {
    const sealedBody = await deps.vault.seal(request.text, identityAad({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId: request.sessionId,
      capturedAt: request.capturedAt,
    }));
    if (!deps.live() || nonWriting || tombstoned.has(request.sessionId)) return;
    if (!sealedBody) {
      // Nothing could be written, so nothing is held: said in the counters
      // rather than kept in memory as if it were stored.
      deps.onWriteRefused();
      return;
    }
    const at = new Date(deps.now()).toISOString();
    const row: TailRow = {
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId: request.sessionId,
      capturedAt: request.capturedAt,
      lastUsedAt: at,
      bytes: request.bytes,
      body: sealedBody,
    };
    let written = await deps.store.put(row);
    if (!written) {
      deps.onWriteRefused();
      // A refused transaction is the storage layer saying it has no room, so
      // the retry must free something: the oldest *other* record, counting the
      // record about to be written. A make-room pass that cannot prove what it
      // deleted is a fault, like every other unproved purge.
      if (!(await evict({ keep: request.sessionId, incoming: { sessionId: request.sessionId, bytes: request.bytes }, minimum: 1 }))) {
        deps.onFault("purge");
        return;
      }
      if (!deps.live() || nonWriting || tombstoned.has(request.sessionId)) return;
      written = await deps.store.put(row);
      if (!written) {
        // Still no room after making some: counted, and nothing is held.
        deps.onWriteRefused();
        return;
      }
    }
    // Committed: now, and only now, is it a record this device holds.
    if (!deps.live()) return;
    const record = openPayload(
      { ...validatedShapeOf(row), body: sealedBody },
      request.text,
      deps.bounds,
    );
    if ("discard" in record) {
      // Its own payload does not validate: nothing is held, and the row goes.
      deps.onWriteRefused();
      if (!(await deps.store.remove([key(request.sessionId)], TAIL_SCAN_LIMITS.batchRows, removeBounds()))) {
        deps.onFault("purge");
      }
      return;
    }
    deps.recency.remember(record, deps.now());
    if (!(await evict({ keep: request.sessionId }))) {
      // On this device but over its bounds, and unable to get back inside
      // them: nothing is served from an over-bound cache.
      deps.recency.forget(request.sessionId);
      deps.onFault("purge");
    }
  }

  async function persistTouch(sessionId: string, persistedBefore: number): Promise<void> {
    // Only a row this build fully validated is ever re-persisted: `held` holds
    // nothing else, and a touch for anything absent is simply dropped.
    const held = deps.recency.held(sessionId);
    const hot = deps.recency.hot(sessionId);
    if (!held || !hot) {
      deps.recency.untouch(sessionId, persistedBefore);
      return;
    }
    const sealedBody = await deps.vault.seal(textOfHot(hot), identityAad({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId,
      capturedAt: hot.capturedAt,
    }));
    if (!deps.live() || nonWriting || tombstoned.has(sessionId)) return;
    if (!sealedBody) {
      deps.recency.untouch(sessionId, persistedBefore);
      deps.onWriteRefused();
      return;
    }
    const written = await deps.store.put({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId,
      capturedAt: hot.capturedAt,
      lastUsedAt: new Date(deps.now()).toISOString(),
      bytes: hot.bytes,
      body: sealedBody,
    });
    if (written || !deps.live()) return;
    // Recency this device claims to have written has to be recency it wrote:
    // the watermark goes back, so the next read tries again instead of
    // believing a transaction that never committed. The use itself stands.
    deps.recency.untouch(sessionId, persistedBefore);
    deps.onWriteRefused();
  }

  async function deleteSessions(sessionIds: readonly string[]): Promise<boolean> {
    if (!(await purge())) {
      deps.onFault("purge");
      return false;
    }
    const removed = await deps.store.remove(sessionIds.map(key), TAIL_SCAN_LIMITS.batchRows, removeBounds());
    for (const sessionId of sessionIds) deps.recency.forget(sessionId);
    if (!removed) {
      deps.onFault("purge");
      return false;
    }
    return true;
  }

  async function clearAll(): Promise<boolean> {
    const doomed: TailKey[] = [];
    const report = await deps.store.scan(
      {
        rows: TAIL_SCAN_LIMITS.scanRows,
        bytes: TAIL_SCAN_LIMITS.scanBytes,
        batch: TAIL_SCAN_LIMITS.batchRows,
        deadline: deadline(),
      },
      (stored) => {
        const key = stored.key;
        if (Array.isArray(key) && key[0] === deps.environmentKey && typeof key[1] === "string") {
          doomed.push([key[0] as string, key[1]]);
        }
      },
    );
    deps.recency.clear();
    // A pass that stopped at a ceiling has seen a prefix of what is here, so
    // deleting what it found would empty part of this device and report it as
    // all of it.
    if (report.outcome !== "complete") {
      deps.onFault(report.outcome === "failed" ? "storage" : "purge");
      return false;
    }
    if (doomed.length === 0) return true;
    if (doomed.length > TAIL_SCAN_LIMITS.deleteRows) {
      deps.onFault("purge");
      return false;
    }
    const removed = await deps.store.remove(doomed, TAIL_SCAN_LIMITS.batchRows, removeBounds());
    if (!removed) {
      deps.onFault("purge");
      return false;
    }
    return true;
  }

  /**
   * Promote stored records into the hot set, inside the queue.
   *
   * It runs as a control op for the same reason a deletion does: it reads the
   * store, it deletes what it cannot read, and it puts records into memory —
   * all of which must be ordered against a `forget` or a `clear` rather than
   * racing them. Every await is followed by a tombstone and non-writing check,
   * so a session deleted or an environment cleared while a body was decrypting
   * is never remembered afterwards.
   */
  async function promotePass(wanted: ReadonlySet<string>): Promise<boolean> {
    if (!deps.live() || nonWriting) return false;
    const found: ValidatedRow[] = [];
    const poisoned: TailKey[] = [];
    const report = await deps.store.scan(
      {
        rows: TAIL_SCAN_LIMITS.scanRows,
        bytes: TAIL_SCAN_LIMITS.scanBytes,
        batch: TAIL_SCAN_LIMITS.batchRows,
        deadline: deadline(),
      },
      (stored) => {
        const parsed = parseStoredRow(stored, { appVersion: deps.appVersion, environmentKey: deps.environmentKey });
        const removable = Array.isArray(stored.key) && typeof stored.key[0] === "string" && typeof stored.key[1] === "string"
          ? ([stored.key[0], stored.key[1]] as TailKey)
          : undefined;
        if ("discard" in parsed) {
          if (removable) poisoned.push(removable);
          return;
        }
        if (!wanted.has(parsed.sessionId)) return;
        found.push(parsed);
        return found.length < wanted.size;
      },
    );
    if (!deps.live() || nonWriting) return false;
    // A partial pass proves nothing about what is there, so nothing is
    // promoted from one.
    if (report.outcome !== "complete") {
      deps.onFault(report.outcome === "failed" ? "storage" : "purge");
      return false;
    }
    for (const row of found) {
      if (tombstoned.has(row.sessionId)) continue;
      if (readableAge(row.capturedAt, deps.now(), deps.bounds.ageMs) === undefined) {
        poisoned.push(row.key as TailKey);
        continue;
      }
      const text = await deps.vault.open(row.body, identityAad({ ...row, schema: row.schema, appVersion: row.appVersion }));
      if (!deps.live() || nonWriting) return false;
      // Deleted or cleared while this body was decrypting: it is not a record
      // this device holds, and remembering it would resurrect it.
      if (tombstoned.has(row.sessionId)) continue;
      if (text === undefined) {
        poisoned.push(row.key as TailKey);
        continue;
      }
      const record = openPayload(row, text, deps.bounds);
      if ("discard" in record) {
        poisoned.push(row.key as TailKey);
        continue;
      }
      deps.recency.remember(record, deps.now());
    }
    if (poisoned.length === 0) return true;
    const removed = await deps.store.remove(poisoned, TAIL_SCAN_LIMITS.batchRows, removeBounds());
    if (!deps.live()) return false;
    for (const row of poisoned) deps.recency.forget(row[1]);
    if (!removed) {
      deps.onFault("purge");
      return false;
    }
    return true;
  }

  return {
    noteRefusedWrite() {
      deps.onWriteRefused();
    },

    promote(sessionIds) {
      if (sealed || !deps.live() || nonWriting) return Promise.resolve(false);
      const wanted = sessionIds.filter((sessionId) => deps.recency.hot(sessionId) === undefined);
      if (wanted.length === 0) return Promise.resolve(true);
      for (const sessionId of wanted) promoteWanted.add(sessionId);
      return new Promise<boolean>((resolve) => {
        if (promoteWaiters) {
          promoteWaiters.settle.push(resolve);
        } else {
          promoteWaiters = { settle: [resolve] };
          control.push({ kind: "promote" });
        }
        pump();
      });
    },

    write(request) {
      if (sealed || nonWriting || !deps.live() || tombstoned.has(request.sessionId)) {
        deps.onWriteRefused();
        return false;
      }
      work.push({ kind: "write", sessionId: request.sessionId, request });
      writeBytes += request.bytes;
      // Shed the oldest **write** (never a control op, never a touch behind a
      // control op) until the work lane is inside its ceilings.
      while (writeBytes > QUEUE_LIMITS.writeBytes || work.filter((op) => op.kind === "write").length > QUEUE_LIMITS.writes) {
        const index = work.findIndex((op) => op.kind === "write");
        if (index < 0) break;
        const [dropped] = work.splice(index, 1);
        if (dropped?.kind === "write") writeBytes -= dropped.request.bytes;
        deps.onWriteRefused();
      }
      pump();
      return true;
    },

    touch(sessionId, persistedBefore) {
      if (sealed || nonWriting || !deps.live()) return;
      if (pendingTouch.has(sessionId) || pendingTouch.size >= QUEUE_LIMITS.touches) return;
      pendingTouch.add(sessionId);
      work.push({ kind: "touch", sessionId, persistedBefore });
      pump();
    },

    forget(sessionId) {
      // Tombstoned on admission, so a queued write for it can never commit —
      // whatever the queue depth, and whether or not this op runs soon.
      tombstoned.add(sessionId);
      return new Promise<boolean>((resolve) => {
        // Coalesced by session: asking twice adds a waiter, never a second
        // deletion, so the control lane stays bounded by the record ceiling
        // however often a surface asks. Nothing runs outside the queue.
        const waiting = forgetWaiters.get(sessionId);
        if (waiting) {
          waiting.settle.push(resolve);
        } else {
          forgetWaiters.set(sessionId, { settle: [resolve] });
          control.push({ kind: "forget", sessionId });
        }
        pump();
      });
    },

    clearEnvironment() {
      // Non-writing from this instant: every queued write and touch is dropped
      // as it dequeues, and nothing new is accepted.
      nonWriting = true;
      return new Promise<boolean>((resolve) => {
        // One clear at a time: a second ask joins the first rather than
        // queueing another pass over the same store.
        if (clearWaiters) {
          clearWaiters.settle.push(resolve);
        } else {
          clearWaiters = { settle: [resolve] };
          control.push({ kind: "clear" });
        }
        pump();
      });
    },

    purgeExpired() {
      return new Promise<boolean>((resolve) => {
        if (purgeWaiters) {
          purgeWaiters.settle.push(resolve);
        } else {
          purgeWaiters = { settle: [resolve] };
          control.push({ kind: "purge" });
        }
        pump();
      });
    },

    drain() {
      if (work.length === 0 && control.length === 0 && !writing) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idle.push(resolve);
        pump();
      });
    },

    depth: () => ({
      writes: work.filter((op) => op.kind === "write").length,
      touches: pendingTouch.size,
      control: control.length,
    }),

    seal() {
      sealed = true;
      nonWriting = true;
      work.length = 0;
      writeBytes = 0;
      pendingTouch.clear();
      tombstoned.clear();
      promoteWanted = new Set();
      // Whoever was waiting on a control op is told, rather than left holding
      // a promise this pass will never settle.
      const waiting = [...forgetWaiters.values(), clearWaiters, purgeWaiters, promoteWaiters];
      forgetWaiters.clear();
      clearWaiters = undefined;
      purgeWaiters = undefined;
      promoteWaiters = undefined;
      control.length = 0;
      for (const waiters of waiting) answer(waiters, false);
    },
  };
}

/** The outside fields of a row we have just written, as validation sees them. */
function validatedShapeOf(row: TailRow): Omit<ValidatedRow, "body"> {
  return {
    key: [row.environmentKey, row.sessionId] as const,
    schema: row.schema,
    appVersion: row.appVersion,
    environmentKey: row.environmentKey,
    sessionId: row.sessionId,
    capturedAt: row.capturedAt,
    lastUsedAt: row.lastUsedAt,
    bytes: row.bytes,
  };
}

/** Re-serialize a hot record's payload for a touch. Exact, never remembered. */
function textOfHot(record: TailRecord): string {
  return JSON.stringify({
    v: TAIL_PAYLOAD_VERSION,
    revision: record.revision,
    leafId: record.leafId,
    epoch: record.epoch,
    seq: record.seq,
    truncated: record.truncated,
    attachmentsOmitted: record.attachmentsOmitted,
    checksum: checksumOf(contentText({ entries: record.entries, attachments: record.attachments })),
    content: { entries: record.entries, attachments: record.attachments },
  });
}

/** Exported for the counters: how much a body really weighs on this device. */
export { storedBytesOf };
