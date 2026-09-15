/**
 * The one authority over cached conversations on this device (RP-10).
 *
 * Nothing else in the product opens a database, and nothing here opens one
 * until the host has said which environment this is and what it allows. The
 * order is the whole design:
 *
 *   version handshake → environment descriptor → validated policy
 *     → **this cache prepares, bounded** → the connection opens
 *
 * Preparation is what makes local-first a guarantee rather than a race
 * (`prepare`, called from `environment-lifecycle.ts`, awaited by the client
 * before it publishes `open`): by the time the app is connected, either a
 * previously seen conversation can be read synchronously from memory, or this
 * cache has honestly refused and nothing will be read at all. Either way the
 * host is reachable — a locked keychain, a hostile database or a browser that
 * blocks storage costs a person their cache, never their conversation.
 *
 * Five rules the code keeps, not the comments:
 *
 * 1. **Opaque identity only.** `(environmentKey, sessionId)`. A path is a
 *    lookup index; a row whose environment is not the live one is never read.
 * 2. **Policy first.** Content is written only when the environment's own
 *    validated policy allows it, with every bound narrowed, never widened.
 *    Forbidden content is deleted, not kept and ignored.
 * 3. **Bounded and fail-closed.** Every scan, delete, eviction and damage pass
 *    has a count, byte, time and yield ceiling. A pass that hits one refuses
 *    to open the cache rather than reading over bytes it could not establish.
 * 4. **Nothing in memory pretending to be durable.** No store, no cache.
 * 5. **Fenced.** Every asynchronous step captures the generation it started in
 *    and drops its result if the environment, socket or page moved on.
 */
import type { CachePolicy, EnvironmentDescriptor } from "@lasercode/protocol";
import { VIEW_TAIL_SCHEMA, type ViewTailDto } from "../view-tail.js";
import { byteLength } from "../view-measure.js";
import {
  TAIL_RECORD_SCHEMA,
  TAIL_SCAN_LIMITS,
  boundsFor,
  policyAdmits,
  type ScanOutcome,
  type TailBounds,
  type TailRefusal,
} from "./bounds.js";
import {
  bodyBytes,
  bodyText,
  bodyTextBytes,
  checksumOf,
  identityAad,
  identityIsReadable,
  normalizeEntry,
  parseBody,
  readableAge,
  type TailAttachmentRef,
  type TailEntryRecord,
  type TailKey,
  type TailRecord,
} from "./record.js";
import { emptyDiscards, type DeviceCacheCounters, type TailCacheStatus, type TailDiscardReason } from "./counters.js";
import { ROW_IDENTITY_ALLOWANCE, rowStoredBytes, type DestroyOutcome, type TailRow, type TailStore } from "./store.js";
import { NULL_VAULT, type TailVault } from "./vault.js";

export type TailCacheState =
  | { kind: "closed" }
  | { kind: "preparing"; environmentKey: string }
  | { kind: "open"; environmentKey: string; bounds: TailBounds }
  | { kind: "refused"; environmentKey?: string | undefined; reason: TailRefusal; stoppedBy?: ScanOutcome | undefined };

export interface TailCacheDeps {
  /** Open the durable store, or answer `undefined`. There is no other store. */
  openStore(): Promise<TailStore | undefined>;
  /** Resolve this device's vault once per environment. */
  resolveVault(): Promise<TailVault>;
  /** Delete the whole database, for the person's own "forget everything". */
  destroy(): Promise<DestroyOutcome>;
  /** This build. A record written by another generation is not read (D-i). */
  appVersion: string;
  now(): number;
  /** Deferred work: writes and evictions never run on the paint path. */
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
  /** Close everything derived from an environment. Nothing stored is deleted. */
  deactivate(): void;
  /** RP-5's sink. Never throws, never awaits, never retains the DTO. */
  release(tail: ViewTailDto): void;
  /** RP-11: synchronous, hot-set only, allocation-free on a hit. */
  peek(path: string): TailRecord | undefined;
  /** RP-11: promote records into the hot set for a later `peek`. Bounded. */
  prime(paths: readonly string[]): Promise<void>;
  /** A record RP-11 has replaced stops being a candidate. */
  supersede(sessionId: string, revision: string): void;
  /** Deletion: a session the person removed loses its tail immediately. */
  forget(target: { path?: string | undefined; sessionId?: string | undefined }): Promise<void>;
  /** The person's own clear, and the environment-reset path. */
  clear(scope: "environment" | "all"): Promise<boolean>;
  counters(): DeviceCacheCounters;
}

/**
 * Every field of a released tail this cache understands.
 *
 * A tail that carries anything else is **refused**, not stored. RP-5 owns that
 * DTO and may add to it — a later slice plans a marker for a tail whose
 * oversized entry bodies were left out (RP-5b) — and a cache that ignored an
 * unknown field would file an excerpt as if it were the whole conversation,
 * for RP-11 to paint as one. Failing closed costs a cache hit until this file
 * learns the new field (and bumps {@link TAIL_RECORD_SCHEMA} if what is stored
 * changes meaning); assuming completeness would cost the truth.
 */
const KNOWN_TAIL_FIELDS: ReadonlySet<string> = new Set([
  "schema",
  "path",
  "sessionId",
  "environmentKey",
  "revision",
  "epoch",
  "seq",
  "leafId",
  "capturedAt",
  "entries",
  "truncated",
  "bytes",
  "omitted",
]);

/** Fields of one entry row this cache understands, for the same reason. */
const KNOWN_ENTRY_FIELDS: ReadonlySet<string> = new Set(["id", "parentId", "at", "json"]);

function carriesOnlyKnownFields(tail: ViewTailDto): boolean {
  for (const field of Object.keys(tail)) if (!KNOWN_TAIL_FIELDS.has(field)) return false;
  for (const entry of tail.entries) {
    for (const field of Object.keys(entry)) if (!KNOWN_ENTRY_FIELDS.has(field)) return false;
  }
  return true;
}

const keyOf = (row: { environmentKey: string; sessionId: string }): TailKey => [row.environmentKey, row.sessionId];
const sameKey = (a: TailKey, b: TailKey): boolean => a[0] === b[0] && a[1] === b[1];

/** Newest first, by the timestamp the person's own use last wrote. */
const byUsedDescending = (a: TailRow, b: TailRow): number => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);

export function createTailCache(deps: TailCacheDeps): TailCache {
  let generation = 0;
  let state: TailCacheState = { kind: "closed" };
  let store: TailStore | undefined;
  let vault: TailVault = NULL_VAULT;
  let policy: CachePolicy | undefined;
  let bounds: TailBounds | undefined;
  let environmentKey: string | undefined;
  let lastClearedAt: string | undefined;
  let stoppedBy: ScanOutcome | undefined;

  /** Records readable without I/O. Frozen, so `peek` allocates nothing. */
  const hot = new Map<string, TailRecord>();
  const hotBySession = new Map<string, string>();
  /** Recency, kept beside the frozen records rather than inside them. */
  const used = new Map<string, number>();
  /** Everything this environment holds, for the bounds and the counters. */
  const held = new Map<string, { sessionId: string; path: string; bytes: number; lastUsedAt: string }>();
  /** One write chain per session: two captures of one tail cannot interleave. */
  const writing = new Map<string, Promise<void>>();

  let evictions = 0;
  let writesRefused = 0;
  let discarded = emptyDiscards();
  const listeners = new Set<(state: TailCacheState) => void>();
  let snapshot: DeviceCacheCounters | undefined;

  const statusOf = (value: TailCacheState): TailCacheStatus => value.kind;

  const publish = (next: TailCacheState): void => {
    state = next;
    snapshot = undefined;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One reader's failure is not another's, and never this module's.
      }
    }
  };

  const discard = (reason: TailDiscardReason): void => {
    discarded = { ...discarded, [reason]: discarded[reason] + 1 };
    snapshot = undefined;
  };

  const heldBytes = (): number => {
    let bytes = 0;
    for (const row of held.values()) bytes += row.bytes;
    return bytes;
  };

  const hotBytes = (): number => {
    let bytes = 0;
    for (const record of hot.values()) bytes += record.bytes;
    return bytes;
  };

  const dropHot = (path: string): void => {
    const record = hot.get(path);
    if (!record) return;
    hot.delete(path);
    used.delete(path);
    if (hotBySession.get(record.sessionId) === path) hotBySession.delete(record.sessionId);
  };

  const closeStore = (): void => {
    store?.close();
    store = undefined;
  };

  /** Forget everything derived from an environment. Nothing stored is deleted. */
  const reset = (): void => {
    generation += 1;
    hot.clear();
    hotBySession.clear();
    used.clear();
    held.clear();
    writing.clear();
    vault = NULL_VAULT;
    policy = undefined;
    bounds = undefined;
    environmentKey = undefined;
    stoppedBy = undefined;
    closeStore();
  };

  /**
   * Close this environment's cache and say why.
   *
   * `pass` is the generation the refusal belongs to: a refusal from a pass the
   * page has already moved past (the connection timed out waiting for it, the
   * environment changed, the socket was replaced) publishes nothing, so a late
   * answer cannot overwrite `closed` with a state nobody is in.
   */
  const refuse = (reason: TailRefusal, key?: string, pass?: number): TailCacheState => {
    if (pass !== undefined && pass !== generation) return state;
    const next: TailCacheState = {
      kind: "refused",
      reason,
      ...(key !== undefined ? { environmentKey: key } : {}),
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    };
    // A refused cache holds nothing in memory either: honest is honest.
    hot.clear();
    hotBySession.clear();
    used.clear();
    held.clear();
    closeStore();
    publish(next);
    return next;
  };

  /** Hold the hot set inside its own ceilings, least recently used first. */
  const trimHot = (): void => {
    const limits = bounds;
    if (!limits) return;
    while (hot.size > TAIL_SCAN_LIMITS.warmRecords || hotBytes() > limits.bytes) {
      let oldestPath: string | undefined;
      let oldest = Infinity;
      for (const [path] of hot) {
        const when = used.get(path) ?? 0;
        if (when < oldest) {
          oldest = when;
          oldestPath = path;
        }
      }
      if (oldestPath === undefined) break;
      dropHot(oldestPath);
    }
  };

  const remember = (record: TailRecord): void => {
    const previous = hotBySession.get(record.sessionId);
    if (previous !== undefined && previous !== record.path) dropHot(previous);
    hot.set(record.path, record);
    hotBySession.set(record.sessionId, record.path);
    used.set(record.path, deps.now());
    held.set(record.sessionId, {
      sessionId: record.sessionId,
      path: record.path,
      bytes: record.bytes,
      lastUsedAt: record.lastUsedAt,
    });
    trimHot();
    snapshot = undefined;
  };

  /**
   * Turn one stored row into the frozen record a reader may hold.
   *
   * Three checks before a single entry is parsed, in this order: the body is
   * inside the per-record byte bound as **measured**, it weighs exactly what
   * the row claimed, and its checksum matches. A row that claims to be tiny
   * and carries a megabyte therefore never becomes a warm record — the claim
   * is not what is trusted, the measurement is.
   */
  const openRow = async (row: TailRow, key: string, limits: TailBounds): Promise<TailRecord | undefined> => {
    const text = await vault.open(row.body, identityAad({ ...row, schema: row.schema, appVersion: row.appVersion }));
    if (text === undefined) {
      discard("undecryptable");
      return undefined;
    }
    const exact = bodyTextBytes(text);
    if (exact > limits.bytesPerSession) {
      discard("oversize");
      return undefined;
    }
    if (exact !== row.bytes) {
      // The accounting this device keeps, and the bound it enforces, are only
      // worth anything if the number beside a body is the body's own size.
      discard("corrupt");
      return undefined;
    }
    if (checksumOf(text) !== row.checksum) {
      discard("corrupt");
      return undefined;
    }
    const body = parseBody(text);
    if (!body) {
      discard("corrupt");
      return undefined;
    }
    if (row.environmentKey !== key) {
      discard("foreign");
      return undefined;
    }
    return Object.freeze({
      schema: TAIL_RECORD_SCHEMA,
      appVersion: row.appVersion,
      environmentKey: row.environmentKey,
      sessionId: row.sessionId,
      path: row.path,
      revision: row.revision,
      leafId: row.leafId,
      epoch: row.epoch,
      seq: row.seq,
      entries: body.entries,
      truncated: row.truncated,
      attachments: body.attachments,
      attachmentsOmitted: row.attachmentsOmitted,
      bytes: row.bytes,
      capturedAt: row.capturedAt,
      lastUsedAt: row.lastUsedAt,
      checksum: row.checksum,
    } satisfies TailRecord);
  };

  /**
   * One bounded pass over the whole database: classify every row, delete what
   * must not survive, prove the deletion, then warm what is left.
   *
   * Every ceiling in `TAIL_SCAN_LIMITS` applies, and any of them failing means
   * this cache does not open. It is the same fail-closed rule the `localStorage`
   * authority keeps: a purge that could not finish keeps the store shut.
   */
  const preparePass = async (key: string, refusal: TailRefusal | undefined, deadline: number, pass: number): Promise<TailCacheState> => {
    const active = store;
    if (!active) return refuse("storage", key, pass);
    const limits = bounds!;
    const doomed: TailKey[] = [];
    const mine: TailRow[] = [];
    const now = deps.now();

    const report = await active.scan(
      { rows: TAIL_SCAN_LIMITS.scanRows, bytes: TAIL_SCAN_LIMITS.scanBytes, batch: TAIL_SCAN_LIMITS.batchRows, deadline },
      (row) => {
        if (typeof row?.environmentKey !== "string" || typeof row.sessionId !== "string") {
          // A row with no identity at all cannot even be addressed for deletion.
          discard("invalid");
          return;
        }
        if (row.environmentKey !== key) {
          doomed.push(keyOf(row));
          discard("foreign");
          return;
        }
        if (refusal) {
          // This environment forbids content. It goes, rather than sitting
          // there waiting for a looser policy to read it back.
          doomed.push(keyOf(row));
          return;
        }
        if (row.schema !== TAIL_RECORD_SCHEMA) {
          doomed.push(keyOf(row));
          discard("schema");
          return;
        }
        if (row.appVersion !== deps.appVersion) {
          doomed.push(keyOf(row));
          discard("version");
          return;
        }
        if (!identityIsReadable(row, deps.appVersion, key) || typeof row.bytes !== "number" || typeof row.checksum !== "string") {
          doomed.push(keyOf(row));
          discard("invalid");
          return;
        }
        // Both the claim and the measurement: a row may not say it is small
        // and carry a megabyte, and it may not be over the bound either way.
        if (row.bytes > limits.bytesPerSession || rowStoredBytes(row) > limits.bytesPerSession + ROW_IDENTITY_ALLOWANCE) {
          doomed.push(keyOf(row));
          discard("oversize");
          return;
        }
        if (readableAge(row.capturedAt, now, limits.ageMs) === undefined) {
          doomed.push(keyOf(row));
          discard("expired");
          return;
        }
        mine.push(row);
      },
    );
    if (report.outcome !== "complete") {
      stoppedBy = report.outcome;
      return refuse(report.outcome === "failed" ? "storage" : "purge", key, pass);
    }
    if (doomed.length > TAIL_SCAN_LIMITS.deleteRows) {
      stoppedBy = "over-rows";
      return refuse("purge", key, pass);
    }

    // Bounds the policy narrowed between runs are enforced here, not only on
    // write: a record that was admissible yesterday may not be today.
    if (!refusal) {
      mine.sort(byUsedDescending);
      let bytes = 0;
      const keep: TailRow[] = [];
      for (const row of mine) {
        if (keep.length >= limits.sessions || bytes + row.bytes > limits.bytes) {
          doomed.push(keyOf(row));
          evictions += 1;
          continue;
        }
        bytes += row.bytes;
        keep.push(row);
      }
      mine.length = 0;
      mine.push(...keep);
    } else {
      mine.length = 0;
    }

    // Every dimension again, now that eviction has added to the list.
    if (doomed.length > TAIL_SCAN_LIMITS.deleteRows) {
      stoppedBy = "over-rows";
      return refuse("purge", key, pass);
    }
    if (doomed.length > 0) {
      const removed = await active.remove(doomed, TAIL_SCAN_LIMITS.batchRows, { rows: TAIL_SCAN_LIMITS.deleteRows, deadline });
      if (!removed) {
        stoppedBy = "failed";
        return refuse("purge", key, pass);
      }
    }
    if (generation !== pass) return state;
    if (refusal) return refuse(refusal, key, pass);

    held.clear();
    for (const row of mine) {
      held.set(row.sessionId, { sessionId: row.sessionId, path: row.path, bytes: row.bytes, lastUsedAt: row.lastUsedAt });
    }

    // Warm the hot set: this is what makes `peek` answer before the connection
    // is open. Bounded by records and bytes, newest use first.
    let warmedBytes = 0;
    const unreadable: TailKey[] = [];
    for (const row of mine.slice(0, TAIL_SCAN_LIMITS.warmRecords)) {
      if (deps.now() > deadline) break;
      if (warmedBytes + row.bytes > limits.bytes) break;
      const record = await openRow(row, key, limits);
      if (!record) {
        unreadable.push(keyOf(row));
        held.delete(row.sessionId);
        continue;
      }
      warmedBytes += record.bytes;
      hot.set(record.path, record);
      hotBySession.set(record.sessionId, record.path);
      used.set(record.path, Date.parse(record.lastUsedAt) || deps.now());
    }
    if (unreadable.length > 0) {
      // Awaited and proved, like every other deletion: a row this build could
      // not open is a row whose provenance was never established, and opening
      // the cache over one would be exactly the assumption this pass refuses
      // to make.
      const removed = await active.remove(unreadable, TAIL_SCAN_LIMITS.batchRows, { rows: TAIL_SCAN_LIMITS.deleteRows, deadline });
      if (!removed) {
        stoppedBy = "failed";
        return refuse("purge", key, pass);
      }
      for (const key of unreadable) held.delete(key[1]);
    }
    if (generation !== pass) return state;
    return { kind: "open", environmentKey: key, bounds: limits };
  };

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async prepare(descriptor, budgetMs) {
      reset();
      const key = descriptor.environmentKey;
      const mine = generation;
      environmentKey = key;
      policy = { ...descriptor.cache };
      bounds = boundsFor(policy);
      discarded = emptyDiscards();
      publish({ kind: "preparing", environmentKey: key });
      const budget = Math.max(0, Math.min(budgetMs ?? TAIL_SCAN_LIMITS.prepareMs, TAIL_SCAN_LIMITS.prepareMs));
      const deadline = deps.now() + budget;
      try {
        // The vault first: whether content may be kept at all can depend on it.
        vault = await deps.resolveVault();
        if (generation !== mine) return state;
        const refusal = policyAdmits(policy) ?? (policy.requireDeviceEncryption && !vault.encrypted ? "encryption" : undefined);
        store = await deps.openStore();
        if (generation !== mine) {
          closeStore();
          return state;
        }
        if (!store) return refuse(refusal ?? "storage", key);
        const next = await preparePass(key, refusal, deadline, mine);
        if (generation !== mine) return state;
        if (next.kind === "open") publish(next);
        return next;
      } catch {
        // Nothing about this device is allowed to take the connection with it —
        // and a rejection that lands after the page moved on publishes nothing,
        // exactly like a late resolution.
        return refuse("storage", key, mine);
      }
    },

    deactivate() {
      reset();
      publish({ kind: "closed" });
    },

    release(tail) {
      if (state.kind !== "open" || !bounds || !environmentKey || !store) return;
      if (tail.schema !== VIEW_TAIL_SCHEMA || tail.omitted !== undefined) return;
      if (tail.environmentKey !== environmentKey) return;
      // A tail this build cannot fully account for is not a cache entry: it
      // would be stored as a complete conversation on the strength of the
      // fields this file happens to know.
      if (!carriesOnlyKnownFields(tail)) {
        writesRefused += 1;
        snapshot = undefined;
        return;
      }
      const limits = bounds;
      const key = environmentKey;
      const mine = generation;
      if (!identityIsReadable({ ...tail, schema: TAIL_RECORD_SCHEMA, appVersion: deps.appVersion }, deps.appVersion, key)) {
        writesRefused += 1;
        snapshot = undefined;
        return;
      }
      // A newer record is never replaced by an older one. Within one worker
      // generation `seq` orders them; across generations only the capture time
      // can, because `seq` restarts (RP-9's epoch is not a clock).
      const existing = hot.get(tail.path);
      if (existing && existing.sessionId === tail.sessionId) {
        const newer = existing.epoch === tail.epoch
          ? existing.seq > tail.seq
          : Date.parse(existing.capturedAt) > Date.parse(tail.capturedAt);
        if (newer) return;
      }

      // Normalize newest-first so trimming to fit drops the oldest rows.
      const rows: Array<{ entry: TailEntryRecord; references: readonly TailAttachmentRef[]; omitted: number }> = [];
      let truncated = tail.truncated;
      for (let index = tail.entries.length - 1; index >= 0; index--) {
        const source = tail.entries[index]!;
        if (rows.length >= limits.entriesPerSession) {
          truncated = true;
          break;
        }
        const normalized = normalizeEntry(source, limits);
        if (!normalized) {
          truncated = true;
          continue;
        }
        rows.push({
          entry: Object.freeze({ id: source.id, parentId: source.parentId, json: normalized.json }),
          references: normalized.references,
          omitted: normalized.omitted,
        });
      }
      rows.reverse();

      /**
       * Fit the **canonical stored body**, not the sum of its entries.
       *
       * A record costs what is written: every entry's id and parent id, the
       * JSON structure around them, the escaping inside them and the
       * attachment references beside them. Measuring only `entry.json` let a
       * record whose ids are long, or whose text is non-Latin, cross the
       * per-record bound — and it was then written, read back as over-bound on
       * the next start, and purged. So the bound is applied to the exact body,
       * oldest row dropped first, until it fits or there is nothing left to
       * drop; a single row that cannot fit alone is refused outright.
       */
      const canonical = () => {
        const body = Object.freeze({
          entries: Object.freeze(rows.map((row) => row.entry)),
          attachments: Object.freeze(rows.flatMap((row) => [...row.references])),
        });
        return { body, text: bodyText(body) };
      };
      let fitted = canonical();
      while (rows.length > 0 && byteLength(fitted.text) > limits.bytesPerSession) {
        rows.shift();
        truncated = true;
        fitted = canonical();
      }
      if (rows.length === 0) {
        writesRefused += 1;
        snapshot = undefined;
        return;
      }
      const omitted = rows.reduce((sum, row) => sum + row.omitted, 0);
      const body = fitted.body;
      const text = fitted.text;
      const at = new Date(deps.now()).toISOString();
      const record: TailRecord = Object.freeze({
        schema: TAIL_RECORD_SCHEMA,
        appVersion: deps.appVersion,
        environmentKey: key,
        sessionId: tail.sessionId,
        path: tail.path,
        revision: tail.revision,
        leafId: tail.leafId ?? null,
        epoch: tail.epoch,
        seq: tail.seq,
        entries: body.entries,
        truncated,
        attachments: body.attachments,
        attachmentsOmitted: omitted,
        bytes: bodyBytes(body),
        capturedAt: tail.capturedAt,
        lastUsedAt: at,
        checksum: checksumOf(text),
      });
      // Deliberately **not** remembered yet. A record becomes readable only
      // once its own atomic write has committed: a hot record behind a
      // transaction that never landed would be an in-memory cache pretending
      // to be a durable one, and `peek` would serve it as though a reload
      // could find it again.

      // The write itself never runs on the path that released the transcript.
      deps.defer(() => {
        if (generation !== mine) return;
        const chain = (writing.get(record.sessionId) ?? Promise.resolve()).then(async () => {
          if (generation !== mine || !store) return;
          const sealed = await vault.seal(text, identityAad(record));
          if (!sealed) {
            // Nothing could be written, so nothing is held: said in the
            // counters rather than kept in memory as if it were stored.
            writesRefused += 1;
            snapshot = undefined;
            return;
          }
          if (generation !== mine || !store) return;
          const row: TailRow = {
            schema: record.schema,
            appVersion: record.appVersion,
            environmentKey: record.environmentKey,
            sessionId: record.sessionId,
            path: record.path,
            revision: record.revision,
            leafId: record.leafId,
            epoch: record.epoch,
            seq: record.seq,
            truncated: record.truncated,
            attachments: [...record.attachments],
            attachmentsOmitted: record.attachmentsOmitted,
            bytes: record.bytes,
            capturedAt: record.capturedAt,
            lastUsedAt: record.lastUsedAt,
            checksum: record.checksum,
            body: sealed,
          };
          const written = await store.put(row);
          if (!written) {
            writesRefused += 1;
            snapshot = undefined;
            // Quota or a refused transaction: make room once, then try again.
            // Nothing about this record is in memory yet, so a second refusal
            // simply leaves this device without it — but a make-room pass that
            // cannot prove what it deleted closes the cache, like every other
            // unproved purge.
            if (!(await evictToFit(limits, record.sessionId, mine))) return;
            if (generation !== mine || !store) return;
            if (!(await store.put(row))) return;
          }
          // Committed: now, and only now, is it a record this device holds.
          if (generation !== mine) return;
          remember(record);
          if (!(await evictToFit(limits, record.sessionId, mine))) {
            // The record is on this device but the environment is over its
            // bounds and could not be brought back inside them. Nothing is
            // served from an over-bound cache: the record just remembered goes
            // out of memory and the cache closes, saying why.
            dropHot(record.path);
            held.delete(record.sessionId);
            snapshot = undefined;
            stoppedBy = "failed";
            refuse("purge", environmentKey, mine);
          }
        });
        writing.set(record.sessionId, chain.catch(() => {}));
      });
    },

    peek(path) {
      if (state.kind !== "open" || !bounds) return undefined;
      const record = hot.get(path);
      if (!record) return undefined;
      if (readableAge(record.capturedAt, deps.now(), bounds.ageMs) === undefined) {
        dropHot(path);
        discard("expired");
        return undefined;
      }
      // Recency lives outside the frozen record, so a hit allocates nothing.
      used.set(path, deps.now());
      return record;
    },

    async prime(paths) {
      if (state.kind !== "open" || !store || !bounds || !environmentKey) return;
      const wanted = new Set(paths.filter((path) => !hot.has(path)));
      if (wanted.size === 0) return;
      const mine = generation;
      const key = environmentKey;
      const found: TailRow[] = [];
      const report = await store.scan(
        {
          rows: TAIL_SCAN_LIMITS.scanRows,
          bytes: TAIL_SCAN_LIMITS.scanBytes,
          batch: TAIL_SCAN_LIMITS.batchRows,
          deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
        },
        (row) => {
          if (row.environmentKey !== key || !wanted.has(row.path)) return;
          found.push(row);
          return found.length < wanted.size;
        },
      );
      // A partial pass proves nothing about what is there, so nothing is
      // promoted from one: `peek` answers `undefined` and the conversation is
      // read from its host, which is the honest outcome.
      if (report.outcome !== "complete" || generation !== mine) {
        if (report.outcome !== "complete") stoppedBy = report.outcome;
        return;
      }
      const limits = bounds;
      const poisoned: TailKey[] = [];
      for (const row of found.slice(0, TAIL_SCAN_LIMITS.warmRecords)) {
        // Anything this build cannot read is not merely skipped: leaving it
        // there would mean every later promotion pays for it again, and the
        // cache would stay open over bytes whose provenance it never
        // established.
        if (!identityIsReadable(row, deps.appVersion, key) || readableAge(row.capturedAt, deps.now(), limits.ageMs) === undefined) {
          poisoned.push(keyOf(row));
          continue;
        }
        const record = await openRow(row, key, limits);
        if (generation !== mine) return;
        if (!record) {
          poisoned.push(keyOf(row));
          continue;
        }
        remember(record);
      }
      if (poisoned.length > 0 && store) {
        const removed = await store.remove(poisoned, TAIL_SCAN_LIMITS.batchRows, {
          rows: TAIL_SCAN_LIMITS.deleteRows,
          deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
        });
        if (generation !== mine) return;
        for (const row of poisoned) held.delete(row[1]);
        snapshot = undefined;
        if (!removed) {
          stoppedBy = "failed";
          refuse("purge", key, generation);
        }
      }
    },

    supersede(sessionId, revision) {
      const path = hotBySession.get(sessionId);
      if (path === undefined) return;
      const record = hot.get(path);
      if (record && record.revision !== revision) dropHot(path);
    },

    async forget(target) {
      if (!store || !environmentKey) return;
      const key = environmentKey;
      const mine = generation;
      let sessionId = target.sessionId;
      if (sessionId === undefined && target.path !== undefined) {
        const record = hot.get(target.path);
        sessionId = record?.sessionId;
        if (sessionId === undefined) {
          for (const row of held.values()) if (row.path === target.path) sessionId = row.sessionId;
        }
      }
      if (target.path !== undefined) dropHot(target.path);
      if (sessionId === undefined) return;
      const row = held.get(sessionId);
      if (row) dropHot(row.path);
      held.delete(sessionId);
      snapshot = undefined;
      const removed = await store.remove([[key, sessionId]], TAIL_SCAN_LIMITS.batchRows, {
        rows: TAIL_SCAN_LIMITS.deleteRows,
        deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
      });
      if (generation !== mine) return;
      if (!removed) {
        // A conversation the person deleted whose tail could not be removed is
        // not something to keep reading: the cache closes and says why.
        stoppedBy = "failed";
        refuse("purge", key, generation);
      }
    },

    async clear(scope) {
      const at = new Date(deps.now()).toISOString();
      if (scope === "all") {
        // Own connections first: a database cannot be deleted underneath them,
        // and the person is promised removal, not an attempt.
        reset();
        // A storage layer that throws did not delete anything, and the person
        // is told that rather than shown a reload that claims it worked.
        const outcome = await deps.destroy().catch(() => "failed" as const);
        const cleared = outcome === "deleted" || outcome === "absent";
        if (cleared) lastClearedAt = at;
        publish({ kind: "closed" });
        return cleared;
      }
      if (!store || !environmentKey) return false;
      const key = environmentKey;
      const doomed: TailKey[] = [];
      const report = await store.scan(
        {
          rows: TAIL_SCAN_LIMITS.scanRows,
          bytes: TAIL_SCAN_LIMITS.scanBytes,
          batch: TAIL_SCAN_LIMITS.batchRows,
          deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
        },
        (row) => {
          if (row.environmentKey === key) doomed.push(keyOf(row));
        },
      );
      hot.clear();
      hotBySession.clear();
      used.clear();
      held.clear();
      snapshot = undefined;
      // A pass that stopped at a ceiling has seen a prefix of what is here, so
      // deleting what it found would empty part of this device and report it as
      // all of it. The person is told it did not finish instead, and the cache
      // stays shut: what is left could not be established.
      if (report.outcome !== "complete") {
        stoppedBy = report.outcome;
        refuse(report.outcome === "failed" ? "storage" : "purge", key, generation);
        return false;
      }
      const removed = doomed.length === 0
        ? true
        : await store.remove(doomed, TAIL_SCAN_LIMITS.batchRows, {
          rows: TAIL_SCAN_LIMITS.deleteRows,
          deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
        });
      if (!removed) {
        stoppedBy = "failed";
        refuse("purge", key, generation);
        return false;
      }
      lastClearedAt = at;
      return true;
    },

    counters() {
      if (snapshot) return snapshot;
      snapshot = Object.freeze({
        status: statusOf(state),
        ...(state.kind === "refused" ? { refusal: state.reason } : {}),
        ...(stoppedBy !== undefined ? { stoppedBy } : {}),
        records: held.size,
        bytes: heldBytes(),
        hotRecords: hot.size,
        hotBytes: hotBytes(),
        evictions,
        writesRefused,
        discarded: Object.freeze({ ...discarded }),
        encryption: vault.encryption,
        durable: store?.durable ?? false,
        ...(bounds ? { bounds } : {}),
        ...(lastClearedAt !== undefined ? { lastClearedAt } : {}),
      } satisfies DeviceCacheCounters);
      return snapshot;
    },
  };

  /**
   * Bring the environment back inside its bounds, least recently used first,
   * in bounded batches. The session just written is evicted last: it is the
   * one the person is looking at.
   *
   * `false` means the bounds are **not** met — a deletion that could not be
   * proved, or a plan that cannot reach the limits inside one pass. The caller
   * closes the cache rather than serving an environment that is over budget
   * and calling itself open.
   */
  async function evictToFit(limits: TailBounds, keepSessionId: string, pass: number): Promise<boolean> {
    if (!store) return false;
    const rows = [...held.values()].sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt));
    const doomed: TailKey[] = [];
    let records = held.size;
    let bytes = heldBytes();
    for (const row of rows) {
      if (records <= limits.sessions && bytes <= limits.bytes) break;
      if (row.sessionId === keepSessionId) continue;
      if (doomed.length >= TAIL_SCAN_LIMITS.deleteRows) break;
      doomed.push([environmentKey!, row.sessionId]);
      records -= 1;
      bytes -= row.bytes;
    }
    // The plan itself has to reach the bounds. If it cannot — more rows over
    // the limit than one pass may delete — saying "inside its bounds" would be
    // untrue whatever the deletions do.
    if (records > limits.sessions || bytes > limits.bytes) return false;
    if (doomed.length === 0) return true;
    const removed = await store.remove(doomed, TAIL_SCAN_LIMITS.batchRows, {
      rows: TAIL_SCAN_LIMITS.deleteRows,
      deadline: deps.now() + TAIL_SCAN_LIMITS.prepareMs,
    });
    if (generation !== pass) return false;
    if (!removed) return false;
    for (const [, sessionId] of doomed) {
      const row = held.get(sessionId);
      if (row) dropHot(row.path);
      held.delete(sessionId);
      evictions += 1;
    }
    snapshot = undefined;
    return true;
  }
}
