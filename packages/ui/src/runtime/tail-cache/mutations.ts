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
  promote(sessionIds: readonly string[]): Promise<void>;
  /** A release this build refused before it ever reached the queue. */
  noteRefusedWrite(): void;
  /** Accept a fitted release. Returns false when the work lane shed it. */
  write(request: WriteRequest): boolean;
  /** Persist a use, coalesced, off the read path. */
  touch(sessionId: string): void;
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
  | { kind: "touch"; sessionId: string }
  | { kind: "forget"; sessionId: string; settle: (ok: boolean) => void }
  | { kind: "clear"; settle: (ok: boolean) => void }
  | { kind: "purge"; settle: (ok: boolean) => void };

export function createMutationOwner(deps: MutationDeps): MutationOwner {
  const work: Op[] = [];
  const control: Op[] = [];
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

  const settleIdle = (): void => {
    if (work.length > 0 || control.length > 0 || writing) return;
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
          if (!deps.live() || nonWriting) continue;
          await persistTouch(op.sessionId);
          continue;
        }
        if (op.kind === "forget") {
          op.settle(await deleteSessions([op.sessionId]));
          continue;
        }
        if (op.kind === "purge") {
          op.settle(await purge());
          continue;
        }
        op.settle(await clearAll());
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
      if (!written) return;
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

  async function persistTouch(sessionId: string): Promise<void> {
    // Only a row this build fully validated is ever re-persisted: `held` holds
    // nothing else, and a touch for anything absent is simply dropped.
    const held = deps.recency.held(sessionId);
    if (!held) return;
    const hot = deps.recency.hot(sessionId);
    if (!hot) return;
    const sealedBody = await deps.vault.seal(textOfHot(hot), identityAad({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId,
      capturedAt: hot.capturedAt,
    }));
    if (!sealedBody || !deps.live() || nonWriting || tombstoned.has(sessionId)) return;
    await deps.store.put({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: deps.appVersion,
      environmentKey: deps.environmentKey,
      sessionId,
      capturedAt: hot.capturedAt,
      lastUsedAt: new Date(deps.now()).toISOString(),
      bytes: hot.bytes,
      body: sealedBody,
    });
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

  return {
    noteRefusedWrite() {
      deps.onWriteRefused();
    },

    async promote(sessionIds) {
      if (!deps.live() || nonWriting) return;
      const wanted = new Set(sessionIds.filter((sessionId) => deps.recency.hot(sessionId) === undefined));
      if (wanted.size === 0) return;
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
      if (!deps.live()) return;
      // A partial pass proves nothing about what is there, so nothing is
      // promoted from one.
      if (report.outcome !== "complete") {
        deps.onFault(report.outcome === "failed" ? "storage" : "purge");
        return;
      }
      for (const row of found) {
        if (readableAge(row.capturedAt, deps.now(), deps.bounds.ageMs) === undefined) {
          poisoned.push(row.key as TailKey);
          continue;
        }
        const text = await deps.vault.open(row.body, identityAad({ ...row, schema: row.schema, appVersion: row.appVersion }));
        if (!deps.live()) return;
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
      if (poisoned.length === 0) return;
      const removed = await deps.store.remove(poisoned, TAIL_SCAN_LIMITS.batchRows, removeBounds());
      if (!deps.live()) return;
      for (const row of poisoned) deps.recency.forget(row[1]);
      if (!removed) deps.onFault("purge");
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

    touch(sessionId) {
      if (sealed || nonWriting || !deps.live()) return;
      if (pendingTouch.has(sessionId) || pendingTouch.size >= QUEUE_LIMITS.touches) return;
      pendingTouch.add(sessionId);
      work.push({ kind: "touch", sessionId });
      pump();
    },

    forget(sessionId) {
      // Tombstoned on admission, so a queued write for it can never commit —
      // whatever the queue depth, and whether or not this op runs soon.
      tombstoned.add(sessionId);
      if (control.length >= QUEUE_LIMITS.control) {
        // Reserved capacity exhausted only by other deletions: run it inline
        // rather than dropping a deletion, which is never shed.
        return deleteSessions([sessionId]);
      }
      return new Promise<boolean>((resolve) => {
        control.push({ kind: "forget", sessionId, settle: resolve });
        pump();
      });
    },

    clearEnvironment() {
      // Non-writing from this instant: every queued write and touch is dropped
      // as it dequeues, and nothing new is accepted.
      nonWriting = true;
      return new Promise<boolean>((resolve) => {
        control.push({ kind: "clear", settle: resolve });
        pump();
      });
    },

    purgeExpired() {
      return new Promise<boolean>((resolve) => {
        control.push({ kind: "purge", settle: resolve });
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
