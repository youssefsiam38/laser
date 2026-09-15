/**
 * When this device's cache is open, and who is allowed to say so (RP-10).
 *
 * The order this coordinator exists to guarantee:
 *
 *   version handshake → environment descriptor → validated policy
 *     → **preparation, bounded** → the connection publishes `open`
 *
 * Preparation is what makes local-first a guarantee rather than a race. By the
 * time the app is connected, either a previously seen conversation is readable
 * synchronously from memory, or this cache has honestly refused. Either way the
 * host is reachable: a locked keychain, a hostile database or a browser that
 * blocks storage costs a person their cache, never their conversation.
 *
 * One pass token, one publisher, and every await fenced:
 *
 * ```
 * closed ──prepare(pass)──▶ preparing ──validated──▶ open
 *    ▲                          │                      │
 *    │                          └── fault/ceiling ────▶ refused
 *    └──── cancel() / deactivate() / clear("all") ◀─────┘
 * ```
 *
 * `cancel()` flips the pass **synchronously**, so nothing that was already
 * awaiting can publish, warm, write or delete afterwards. Every retained row is
 * validated and authenticated before it enters the accounting; at most
 * `warmRecords` of them keep their parsed objects.
 */
import type { CachePolicy, EnvironmentDescriptor } from "@lasercode/protocol";
import {
  TAIL_HARD_LIMITS,
  TAIL_SCAN_LIMITS,
  boundsFor,
  policyAdmits,
  type ScanOutcome,
  type TailBounds,
  type TailRefusal,
} from "./bounds.js";
import { openPayload, parseStoredRow, readableAge, storedBytesOf, type ValidatedRow } from "./admission.js";
import { identityAad, type TailKey, type TailRecord } from "./record.js";
import { createRecencyIndex, type HeldRow, type RecencyIndex } from "./recency.js";
import { createMutationOwner, type MutationFault, type MutationOwner } from "./mutations.js";
import type { TailStore } from "./store.js";
import { NULL_VAULT, type TailVault } from "./vault.js";
import { emptyDiscards, type DeviceCacheCounters, type TailDiscardReason } from "./counters.js";

export type TailCacheState =
  | { kind: "closed" }
  | { kind: "preparing"; environmentKey: string }
  | { kind: "open"; environmentKey: string; bounds: TailBounds }
  | { kind: "refused"; environmentKey?: string | undefined; reason: TailRefusal; stoppedBy?: ScanOutcome | undefined };

export interface LifecycleDeps {
  /** How long one queued mutation may take, in total (default: the pass budget). */
  budgetMs?: number | undefined;
  openStore(): Promise<TailStore | undefined>;
  resolveVault(): Promise<TailVault>;
  destroy(): Promise<"deleted" | "absent" | "blocked" | "failed">;
  appVersion: string;
  now(): number;
}

/** A pass, and the single flag that ends it. */
export interface Pass {
  readonly id: number;
  live: boolean;
}

export interface Lifecycle {
  state(): TailCacheState;
  subscribe(listener: (state: TailCacheState) => void): () => void;
  prepare(descriptor: EnvironmentDescriptor, budgetMs?: number): Promise<TailCacheState>;
  /** The connection stopped waiting, or the environment went away. */
  cancel(): void;
  counters(): DeviceCacheCounters;
  /** The live pass's collaborators, or `undefined` when the cache is not open. */
  open(): { pass: Pass; bounds: TailBounds; recency: RecencyIndex; mutations: MutationOwner; environmentKey: string } | undefined;
  /**
   * The whole-database recovery, which needs no open store.
   *
   * `issuedIn` is the pass the person asked in. If a reconnect has opened a
   * newer one since, the deletion still happens — they asked to forget what is
   * on this device — but it neither tears down nor closes the pass that opened
   * after it.
   */
  destroyEverything(issuedIn?: Pass | undefined): Promise<boolean>;
  markCleared(): void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  let pass: Pass = { id: 0, live: false };
  let state: TailCacheState = { kind: "closed" };
  let store: TailStore | undefined;
  let vault: TailVault = NULL_VAULT;
  let bounds: TailBounds | undefined;
  let environmentKey: string | undefined;
  let mutations: MutationOwner | undefined;
  let recency: RecencyIndex = createRecencyIndex({ records: TAIL_SCAN_LIMITS.warmRecords, bytes: TAIL_HARD_LIMITS.hotBytes });
  let discarded = emptyDiscards();
  let stoppedBy: ScanOutcome | undefined;
  let evictions = 0;
  let writesRefused = 0;
  let lastClearedAt: string | undefined;
  let snapshot: DeviceCacheCounters | undefined;
  const listeners = new Set<(state: TailCacheState) => void>();

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

  /** End the current pass synchronously: nothing awaiting it may act again. */
  const end = (): void => {
    pass.live = false;
    mutations?.seal();
    mutations = undefined;
    recency.clear();
    store?.close();
    store = undefined;
    vault = NULL_VAULT;
    bounds = undefined;
    environmentKey = undefined;
    snapshot = undefined;
  };

  const refuse = (reason: TailRefusal, key: string | undefined, mine: Pass): TailCacheState => {
    if (mine !== pass || !mine.live) return state;
    end();
    const next: TailCacheState = {
      kind: "refused",
      reason,
      ...(key !== undefined ? { environmentKey: key } : {}),
      ...(stoppedBy !== undefined ? { stoppedBy } : {}),
    };
    publish(next);
    return next;
  };

  /** A fault from the mutation owner closes the cache; it never publishes itself. */
  const onFault = (fault: MutationFault, mine: Pass, key: string): void => {
    if (mine !== pass || !mine.live) return;
    stoppedBy = "failed";
    refuse(fault, key, mine);
  };

  /**
   * Await one dependency with a hard deadline.
   *
   * A stuck keychain bridge, a database that never answers or a decrypt that
   * hangs must not leave this cache `preparing` for ever after the socket has
   * gone. `undefined` means the budget ran out.
   */
  const within = async <T>(work: Promise<T>, mine: Pass, deadline: number): Promise<
    { ok: true; value: T } | { ok: false; reason: "expired" | "failed" | "cancelled" }
  > => {
    const remaining = Math.max(0, deadline - deps.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), remaining);
    });
    try {
      const answer = await Promise.race([work.then((value) => ({ value })), expiry]);
      if (mine !== pass || !mine.live) return { ok: false, reason: "cancelled" };
      // The reason matters: a dependency that ran out of time is not a
      // dependency that failed, and a row whose body did not arrive in time is
      // not a row this pass may call undecryptable.
      if (!answer) return { ok: false, reason: "expired" };
      return { ok: true, value: answer.value };
    } catch {
      return { ok: false, reason: "failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    open() {
      if (state.kind !== "open" || !bounds || !mutations || !environmentKey) return undefined;
      return { pass, bounds, recency, mutations, environmentKey };
    },

    cancel() {
      const wasActive = pass.live || state.kind !== "closed";
      end();
      if (wasActive) publish({ kind: "closed" });
    },

    markCleared() {
      lastClearedAt = new Date(deps.now()).toISOString();
      snapshot = undefined;
    },

    async destroyEverything(issuedIn) {
      // Fenced at both ends. A reconnect may have opened a newer pass while
      // this deletion was being asked for or carried out, and neither the
      // teardown nor the answer may reach into it: the person asked to forget
      // what is on this device, not to close whatever opened since.
      const mine = issuedIn ?? pass;
      if (mine === pass) end();
      const outcome = await deps.destroy().catch(() => "failed" as const);
      const cleared = outcome === "deleted" || outcome === "absent";
      if (cleared) lastClearedAt = new Date(deps.now()).toISOString();
      // A newer pass may have opened while the deletion was outstanding (the
      // registry refuses an open only while one is *pending*), and this answer
      // must not close it. The caller still learns what the deletion did.
      if (mine === pass) publish({ kind: "closed" });
      return cleared;
    },

    async prepare(descriptor, budgetMs) {
      end();
      const mine: Pass = { id: pass.id + 1, live: true };
      pass = mine;
      const key = descriptor.environmentKey;
      const policy: CachePolicy = { ...descriptor.cache };
      environmentKey = key;
      bounds = boundsFor(policy);
      discarded = emptyDiscards();
      stoppedBy = undefined;
      recency = createRecencyIndex({ records: TAIL_SCAN_LIMITS.warmRecords, bytes: TAIL_HARD_LIMITS.hotBytes });
      publish({ kind: "preparing", environmentKey: key });

      const budget = Math.max(0, Math.min(budgetMs ?? TAIL_SCAN_LIMITS.prepareMs, TAIL_SCAN_LIMITS.prepareMs));
      const deadline = deps.now() + budget;
      const limits = bounds;

      // The vault first: whether content may be kept at all can depend on it.
      const resolved = await within(deps.resolveVault(), mine, deadline);
      if (mine !== pass || !mine.live) return state;
      if (!resolved.ok) return resolved.reason === "cancelled" ? state : refuse("storage", key, mine);
      vault = resolved.value;
      const refusal = policyAdmits(policy) ?? (policy.requireDeviceEncryption && !vault.encrypted ? "encryption" : undefined);

      const pendingOpen = deps.openStore();
      const opened = await within(pendingOpen, mine, deadline);
      if (!opened.ok || mine !== pass || !mine.live) {
        // A store that arrives after this pass gave up on it is closed rather
        // than left open: a refused attempt must hold nothing.
        void pendingOpen.then((late) => {
          if (late && (mine !== pass || !mine.live || !opened.ok)) late.close();
        }).catch(() => {});
      }
      if (mine !== pass || !mine.live) return state;
      if (!opened.ok) return opened.reason === "cancelled" ? state : refuse(refusal ?? "storage", key, mine);
      const active = opened.value;
      if (!active) return refuse(refusal ?? "storage", key, mine);
      store = active;

      const doomed: TailKey[] = [];
      const candidates: ValidatedRow[] = [];
      /** A row this build could not even address, so nothing can remove it. */
      let unaddressable = false;
      const scanned = await within(active.scan(
        { rows: TAIL_SCAN_LIMITS.scanRows, bytes: TAIL_SCAN_LIMITS.scanBytes, batch: TAIL_SCAN_LIMITS.batchRows, deadline },
        (stored) => {
          const parsed = parseStoredRow(stored, { appVersion: deps.appVersion, environmentKey: key });
          const removable = Array.isArray(stored.key) && typeof stored.key[0] === "string" && typeof stored.key[1] === "string"
            ? ([stored.key[0], stored.key[1]] as TailKey)
            : undefined;
          if ("discard" in parsed) {
            discard(parsed.discard);
            // Removable by its primary key even when its own fields are junk.
            // One that cannot even be addressed is not something to count and
            // carry on from: this device holds data this build cannot account
            // for, and the cache does not open over it.
            if (removable) doomed.push(removable);
            else unaddressable = true;
            return;
          }
          if (refusal) {
            // This environment forbids content. It goes, rather than sitting
            // there waiting for a looser policy to read it back.
            doomed.push(parsed.key as TailKey);
            return;
          }
          if (parsed.bytes > limits.bytesPerSession || storedBytesOf(parsed.body) > limits.bytesPerSession + 2_048) {
            doomed.push(parsed.key as TailKey);
            discard("oversize");
            return;
          }
          if (readableAge(parsed.capturedAt, deps.now(), limits.ageMs) === undefined) {
            doomed.push(parsed.key as TailKey);
            discard("expired");
            return;
          }
          candidates.push(parsed);
        },
      ), mine, deadline);
      if (mine !== pass || !mine.live) return state;
      // A store that rejects or never answers is a storage failure, not a
      // reason for `prepare` to reject or hang: the contract is that it always
      // resolves with a state.
      if (!scanned.ok) {
        stoppedBy = scanned.reason === "expired" ? "over-time" : "failed";
        return refuse(scanned.reason === "expired" ? "purge" : "storage", key, mine);
      }
      const report = scanned.value;
      if (report.outcome !== "complete") {
        stoppedBy = report.outcome;
        return refuse(report.outcome === "failed" ? "storage" : "purge", key, mine);
      }
      if (unaddressable) {
        stoppedBy = "failed";
        return refuse("purge", key, mine);
      }

      // Least recently **used** first, and only then the record ceiling: the
      // order rows happen to sit in under their keys is not recency, and
      // deciding by it would throw away the newest records on a device that
      // holds more than the policy allows.
      candidates.sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
      const validated = candidates.slice(0, limits.sessions);
      for (const over of candidates.slice(limits.sessions)) {
        doomed.push(over.key as TailKey);
        evictions += 1;
      }

      // **Every** retained row is authenticated before it is counted as held;
      // only the newest few keep their parsed objects.
      const heldRows: HeldRow[] = [];
      const warm: TailRecord[] = [];
      let bytes = 0;
      for (const row of validated) {
        const opened = await within(
          vault.open(row.body, identityAad({ ...row, schema: row.schema, appVersion: row.appVersion })),
          mine,
          deadline,
        );
        if (mine !== pass || !mine.live) return state;
        if (!opened.ok && opened.reason !== "failed") {
          // Out of budget, not out of trust: a row whose body could not be
          // opened *in time* is not a row this pass may call undecryptable,
          // and a cache cannot open over rows nobody established.
          if (opened.reason === "cancelled") return state;
          stoppedBy = "over-time";
          return refuse("purge", key, mine);
        }
        const text = opened.ok ? opened.value : undefined;
        if (text === undefined) {
          doomed.push(row.key as TailKey);
          discard("undecryptable");
          continue;
        }
        const record = openPayload(row, text, limits);
        if ("discard" in record) {
          doomed.push(row.key as TailKey);
          discard(record.discard);
          continue;
        }
        if (bytes + record.bytes > limits.bytes) {
          doomed.push(row.key as TailKey);
          evictions += 1;
          continue;
        }
        bytes += record.bytes;
        heldRows.push({
          sessionId: record.sessionId,
          bytes: record.bytes,
          usedAt: Date.parse(record.lastUsedAt) || deps.now(),
          capturedAt: record.capturedAt,
          epoch: record.epoch,
          seq: record.seq,
          revision: record.revision,
        });
        if (warm.length < TAIL_SCAN_LIMITS.warmRecords) warm.push(record);
      }
      if (deps.now() > deadline) {
        // Validation could not finish inside the pass's own budget: refuse
        // rather than open over rows nobody has established.
        stoppedBy = "over-time";
        return refuse("purge", key, mine);
      }

      if (doomed.length > TAIL_SCAN_LIMITS.deleteRows) {
        stoppedBy = "over-rows";
        return refuse("purge", key, mine);
      }
      if (doomed.length > 0) {
        // The **pass's own** deadline, not a fresh one: vault, open, scan,
        // every decrypt and this purge share one budget, so preparation cannot
        // quietly run to twice what it declared.
        const purged = await within(active.remove(doomed, TAIL_SCAN_LIMITS.batchRows, {
          rows: TAIL_SCAN_LIMITS.deleteRows,
          deadline,
        }), mine, deadline);
        if (mine !== pass || !mine.live) return state;
        if (!purged.ok || !purged.value) {
          stoppedBy = purged.ok ? "failed" : purged.reason === "expired" ? "over-time" : "failed";
          return refuse("purge", key, mine);
        }
      }
      if (refusal) return refuse(refusal, key, mine);
      if (mine !== pass || !mine.live) return state;

      // Published atomically, after the last await: nothing partial is ever
      // visible, and a cancelled pass publishes nothing at all.
      recency.adopt(heldRows, warm);
      mutations = createMutationOwner({
        store: active,
        vault,
        recency,
        bounds: limits,
        environmentKey: key,
        appVersion: deps.appVersion,
        now: deps.now,
        ...(deps.budgetMs !== undefined ? { budgetMs: deps.budgetMs } : {}),
        live: () => mine === pass && mine.live,
        onFault: (fault) => onFault(fault, mine, key),
        onWriteRefused: () => {
          writesRefused += 1;
          snapshot = undefined;
        },
        onEvicted: (count) => {
          evictions += count;
          snapshot = undefined;
        },
      });
      const next: TailCacheState = { kind: "open", environmentKey: key, bounds: limits };
      publish(next);
      return next;
    },

    counters() {
      if (snapshot) return snapshot;
      const depth = mutations?.depth();
      snapshot = Object.freeze({
        status: state.kind,
        ...(state.kind === "refused" ? { refusal: state.reason } : {}),
        ...(stoppedBy !== undefined ? { stoppedBy } : {}),
        records: recency.records(),
        bytes: recency.bytes(),
        hotRecords: recency.hotRecords(),
        hotBytes: recency.hotBytes(),
        evictions,
        writesRefused,
        discarded: Object.freeze({ ...discarded }),
        encryption: vault.encryption,
        durable: store?.durable ?? false,
        ...(bounds ? { bounds } : {}),
        ...(lastClearedAt !== undefined ? { lastClearedAt } : {}),
        ...(depth ? { queued: Object.freeze(depth) } : {}),
      } satisfies DeviceCacheCounters);
      return snapshot;
    },
  };
}
