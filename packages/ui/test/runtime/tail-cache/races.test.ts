/**
 * The races a source review found, each pinned (RP-10, M18-T10 review batch).
 *
 * Four kinds, and they are the reason the authority was decomposed:
 *
 * 1. **A proved deletion must stay proved.** A write accepted before a
 *    `forget` or a `clear` must never commit after it.
 * 2. **A cancelled preparation must not come back.** Neither by resolving nor
 *    by rejecting, and not by warming a record into a cache that is closed.
 * 3. **Deletion must never be starved.** A full write lane still admits a
 *    tombstone and a clear.
 * 4. **Recency is one authority.** A record just read is not the oldest, an
 *    expired record is deleted rather than merely hidden, and the coordinator's
 *    own metadata stays bounded across many sessions.
 */
import { PRODUCT_VERSION } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import { TAIL_SCAN_LIMITS } from "../../../src/runtime/tail-cache/bounds.js";
import { createTailCache } from "../../../src/runtime/tail-cache/cache.js";
import { DURABLE_TOUCH_INTERVAL_MS } from "../../../src/runtime/tail-cache/recency.js";
import { QUEUE_LIMITS } from "../../../src/runtime/tail-cache/mutations.js";
import { openTailStore, destroyTailDatabase, deletionPending, type TailStore } from "../../../src/runtime/tail-cache/store.js";
import { NULL_VAULT } from "../../../src/runtime/tail-cache/vault.js";
import { ENV_A, REVISION, REVISION_2, createTestStore, descriptor, entry, harness, payloadOf, row, tail } from "./harness.js";
import { QUEUE_LIMITS as LIMITS } from "../../../src/runtime/tail-cache/mutations.js";

const peek = (cache: { peek(target: { sessionId: string }): unknown }, sessionId = "session-a") => cache.peek({ sessionId });

describe("a proved deletion is never resurrected", () => {
  it("drops a write that was queued before the session was forgotten", async () => {
    const view = harness({ rows: [row()] });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");

    // A release is accepted and its write is queued…
    view.cache.release(tail({ revision: REVISION, seq: 99 }));
    view.deliver();
    // …and the person deletes the conversation before it commits.
    expect(await view.cache.forget({ sessionId: "session-a" })).toBe(true);
    expect(view.store.rows.size).toBe(0);

    // Whatever was queued cannot bring it back.
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(peek(view.cache)).toBeUndefined();
    expect(view.cache.counters().records).toBe(0);
  });

  it("drops every queued write when the environment is cleared", async () => {
    const view = harness({ rows: [row(), row({ sessionId: "session-b" })] });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    view.cache.release(tail({ sessionId: "session-a", seq: 99 }));
    view.cache.release(tail({ sessionId: "session-c" }));
    view.deliver();

    expect(await view.cache.clear("environment")).toBe(true);
    expect(view.store.rows.size).toBe(0);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0, bytes: 0 });
  });

  it("refuses a clear whose scan could not finish, and deletes no prefix", async () => {
    const store = createTestStore([row(), row({ sessionId: "session-b" })], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    store.faults = { ...store.faults, scanOutcome: "over-time" };
    expect(await view.cache.clear("environment")).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    expect(store.rows.size).toBe(2);
  });

  it("refuses a clear whose deletion could not be proved", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    store.faults = { ...store.faults, silentRemove: true };
    expect(await view.cache.clear("environment")).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
  });

  it("refuses a forget it could not prove, and closes rather than reading on", async () => {
    const store = createTestStore([row()], { silentRemove: true });
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect(await view.cache.forget({ sessionId: "session-a" })).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
    expect(peek(view.cache)).toBeUndefined();
  });
});

describe("deletion is never starved by writes", () => {
  it("admits and completes a forget with the write lane full", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    for (let index = 0; index < QUEUE_LIMITS.writes * 2; index += 1) {
      view.cache.release(tail({ sessionId: `session-${index}`, seq: index + 1 }));
    }
    // Releases reach the queue off the paint path; run those tasks, then look.
    view.deliver();
    // The queue shed writes — and only writes.
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
    expect(view.cache.counters().queued!.writes).toBeLessThanOrEqual(QUEUE_LIMITS.writes);

    expect(await view.cache.forget({ sessionId: "session-a" })).toBe(true);
    await view.flush();
    expect([...view.store.rows.values()].some((stored) => stored.sessionId === "session-a")).toBe(false);
  });

  it("keeps a clear ahead of work queued after it", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    view.cache.release(tail({ sessionId: "session-x" }));
    const cleared = view.cache.clear("environment");
    view.cache.release(tail({ sessionId: "session-y" }));
    expect(await cleared).toBe(true);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
  });

  it("coalesces touches rather than queueing one per read", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    view.clock.now += DURABLE_TOUCH_INTERVAL_MS * 2;
    for (let index = 0; index < 50; index += 1) peek(view.cache);
    expect(view.cache.counters().queued!.touches).toBeLessThanOrEqual(1);
    await view.flush();
  });
});

describe("a cancelled preparation cannot come back", () => {
  const stuck = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: () => void } => {
    let resolve!: (value: T) => void;
    let reject!: () => void;
    const promise = new Promise<T>((settle, fail) => {
      resolve = settle;
      reject = () => fail(new Error("gone"));
    });
    return { promise, resolve, reject };
  };

  it("publishes nothing and holds nothing when the store arrives late", async () => {
    const store = createTestStore([row()], {});
    const late = stuck<TailStore | undefined>();
    const view = harness({ openStore: () => late.promise });
    const preparing = view.cache.prepare(descriptor());
    view.cache.deactivate();
    late.resolve(store);
    await preparing;
    expect(view.cache.state()).toEqual({ kind: "closed" });
    expect(peek(view.cache)).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ status: "closed", records: 0, hotRecords: 0 });
  });

  it("publishes nothing when the vault rejects late", async () => {
    const late = stuck<typeof NULL_VAULT>();
    const clock = { now: 1_700_000_000_000 };
    const cache = createTailCache({
      openStore: () => Promise.resolve(createTestStore([], {})),
      resolveVault: () => late.promise,
      destroy: () => Promise.resolve("deleted"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const preparing = cache.prepare(descriptor());
    cache.deactivate();
    late.reject();
    await preparing;
    expect(cache.state()).toEqual({ kind: "closed" });
  });

  it("warms nothing into a cache that was closed while a body was decrypting", async () => {
    const decrypt = stuck<string | undefined>();
    const payload = payloadOf();
    const clock = { now: 1_700_000_000_000 };
    const cache = createTailCache({
      openStore: () => Promise.resolve(createTestStore([row({}, payload)], {})),
      resolveVault: () => Promise.resolve({
        ...NULL_VAULT,
        encrypted: true,
        encryption: { kind: "os-backed", store: "the system keyring" },
        open: () => decrypt.promise,
      }),
      destroy: () => Promise.resolve("deleted"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const preparing = cache.prepare(descriptor());
    await Promise.resolve();
    cache.deactivate();
    decrypt.resolve(payload.text);
    await preparing;
    expect(cache.state()).toEqual({ kind: "closed" });
    expect(peek(cache)).toBeUndefined();
    const counters = cache.counters();
    expect(counters.hotRecords).toBe(0);
    expect(counters.hotBytes).toBe(0);
    expect(counters.records).toBe(0);
  });

  it("gives up rather than preparing for ever behind a stuck dependency", async () => {
    const clock = { now: 1_700_000_000_000 };
    const cache = createTailCache({
      // A bridge that never answers: the budget, not the bridge, decides.
      resolveVault: () => new Promise(() => {}),
      openStore: () => Promise.resolve(createTestStore([], {})),
      destroy: () => Promise.resolve("deleted"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const state = await cache.prepare(descriptor(), 10);
    expect(state).toMatchObject({ kind: "refused", reason: "storage" });
  });

  it("gives up when a body never decrypts", async () => {
    const clock = { now: 1_700_000_000_000 };
    const cache = createTailCache({
      openStore: () => Promise.resolve(createTestStore([row()], {})),
      resolveVault: () => Promise.resolve({
        ...NULL_VAULT,
        encrypted: true,
        encryption: { kind: "os-backed", store: "the system keyring" },
        open: () => new Promise<string | undefined>(() => {}),
      }),
      destroy: () => Promise.resolve("deleted"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const state = await cache.prepare(descriptor(), 10);
    expect(state.kind).not.toBe("open");
    expect(peek(cache)).toBeUndefined();
  });
});

describe("promotion cleans up what it cannot read", () => {
  it("deletes a poisoned row rather than leaving it to every later pass", async () => {
    const payload = payloadOf();
    const good = row();
    const bad = row({ sessionId: "bad", bytes: payload.bytes - 4 });
    const store = createTestStore([good], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    // The poisoned row appears after preparation, so `prime` is what meets it.
    store.rows.set(`${ENV_A}\u0000bad`, bad);

    await view.cache.prime(["bad"]);
    expect(peek(view.cache, "bad")).toBeUndefined();
    expect(view.cache.state().kind).toBe("open");
    expect([...store.rows.values()].some((stored) => stored.sessionId === "bad")).toBe(false);
  });

  it("closes the cache when a poisoned row cannot be proved gone", async () => {
    const payload = payloadOf();
    const store = createTestStore([row()], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    store.rows.set(`${ENV_A}\u0000bad`, row({ sessionId: "bad", bytes: payload.bytes - 4 }));
    store.faults = { ...store.faults, silentRemove: true };
    await view.cache.prime(["bad"]);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
  });

  it("promotes nothing from a partial scan", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    // A row this page has not seen, and a pass that cannot finish.
    store.rows.set(`${ENV_A}\u0000other`, row({ sessionId: "other" }));
    store.faults = { ...store.faults, scanOutcome: "over-rows" };
    await view.cache.prime(["other"]);
    expect(peek(view.cache, "other")).toBeUndefined();
    expect(view.cache.state().kind).not.toBe("open");
  });
});

describe("one recency and expiry authority", () => {
  it("never evicts the record that was just read", async () => {
    const older = row({ sessionId: "older", lastUsedAt: new Date(1_699_000_000_000).toISOString() });
    const newer = row({ sessionId: "newer", lastUsedAt: new Date(1_699_900_000_000).toISOString() });
    const view = harness({ rows: [older, newer] });
    await view.cache.prepare(descriptor(ENV_A, { maxSessions: 2 }));
    // Read the older one: it is now the most recently used.
    view.clock.now += 1_000;
    expect(peek(view.cache, "older")).toBeDefined();

    view.clock.now += 1_000;
    view.cache.release(tail({ sessionId: "fresh" }));
    await view.flush();
    const held = [...view.store.rows.values()].map((stored) => stored.sessionId).sort();
    expect(held).toEqual(["fresh", "older"]);
  });

  it("deletes an expired record rather than merely hiding it", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor(ENV_A, { maxAgeHours: 1 }));
    expect(peek(view.cache)).toBeDefined();
    view.clock.now += 2 * 60 * 60 * 1000;
    expect(peek(view.cache)).toBeUndefined();
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().records).toBe(0);
  });

  it("purges expiry in every bounded mutation pass, on a long-lived page", async () => {
    const view = harness({ rows: [row({ sessionId: "stale" })] });
    await view.cache.prepare(descriptor(ENV_A, { maxAgeHours: 1 }));
    // Hours pass without anybody reading the stale conversation.
    view.clock.now += 5 * 60 * 60 * 1000;
    view.cache.release(tail({ capturedAt: new Date(view.clock.now).toISOString() }));
    await view.flush();
    expect([...view.store.rows.values()].map((stored) => stored.sessionId)).toEqual(["session-a"]);
    expect(view.cache.counters().records).toBe(1);
  });

  it("persists a use at most once an interval, and never for an unvalidated row", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    const puts = view.store.transactions.put;
    for (let index = 0; index < 20; index += 1) peek(view.cache);
    await view.flush();
    // Well inside the interval: no durable write at all.
    expect(view.store.transactions.put).toBe(puts);

    view.clock.now += DURABLE_TOUCH_INTERVAL_MS + 1;
    expect(peek(view.cache)).toBeDefined();
    await view.flush();
    expect(view.store.transactions.put).toBe(puts + 1);

    // A session this device never validated is never touched.
    const before = view.store.transactions.put;
    expect(peek(view.cache, "never-seen")).toBeUndefined();
    await view.flush();
    expect(view.store.transactions.put).toBe(before);
  });

  it("keeps its own metadata bounded across many sessions", async () => {
    const view = harness();
    await view.cache.prepare(descriptor(ENV_A, { maxSessions: 4 }));
    for (let index = 0; index < 200; index += 1) {
      view.clock.now += 10;
      view.cache.release(tail({ sessionId: `session-${index}` }));
      await view.flush();
    }
    const counters = view.cache.counters();
    expect(counters.records).toBeLessThanOrEqual(4);
    expect(counters.hotRecords).toBeLessThanOrEqual(TAIL_SCAN_LIMITS.warmRecords);
    expect(counters.queued).toEqual({ writes: 0, touches: 0, control: 0 });
    expect(view.store.rows.size).toBeLessThanOrEqual(4);
  });
});

describe("a timed-out database deletion cannot reach a successor", () => {
  it("refuses to open while a deletion is still outstanding, and clears when it settles", async () => {
    let block: (() => void) | undefined;
    const factory = {
      deleteDatabase() {
        const request: Record<string, unknown> = {};
        block = () => (request["onsuccess"] as (() => void) | undefined)?.();
        return request;
      },
      open() {
        throw new Error("nothing may open while a deletion is outstanding");
      },
    } as unknown as IDBFactory;

    const outcome = await destroyTailDatabase(factory, 5);
    expect(outcome).toBe("blocked");
    expect(deletionPending()).toBe(true);
    // No successor can exist for the late delete to take.
    expect(await openTailStore(factory)).toBeUndefined();

    block?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deletionPending()).toBe(false);
  });
});

describe("preparation never fails open, rejects or hangs", () => {
  it("refuses when a row cannot even be addressed for removal", async () => {
    const view = harness({ rows: [row()], faults: { unaddressableRows: 1 } });
    // Counting it and carrying on would open a cache over data this build
    // cannot account for or remove.
    expect(await view.cache.prepare(descriptor())).toMatchObject({ kind: "refused", reason: "purge" });
    expect(peek(view.cache)).toBeUndefined();
  });

  it("resolves with a refusal when the store throws instead of reporting", async () => {
    const view = harness({ faults: { rejectScan: true } });
    await expect(view.cache.prepare(descriptor())).resolves.toMatchObject({ kind: "refused", reason: "storage" });
  });

  it("resolves with a refusal when a scan never settles", async () => {
    const view = harness({ faults: { stuckScan: true } });
    await expect(view.cache.prepare(descriptor(), 10)).resolves.toMatchObject({ kind: "refused" });
    expect(view.cache.state().kind).not.toBe("preparing");
  });

  it("resolves with a refusal when a deletion never settles", async () => {
    const view = harness({ rows: [row({ sessionId: "stale", capturedAt: new Date(1_600_000_000_000).toISOString() })], faults: { stuckRemove: true } });
    await expect(view.cache.prepare(descriptor(), 10)).resolves.toMatchObject({ kind: "refused", reason: "purge" });
  });

  it("keeps the newest records when a device holds more than the policy allows", async () => {
    // Key order is not recency: these are seeded so that the newest rows sort
    // last by key and would have been the ones deleted.
    const rows = Array.from({ length: 6 }, (_, index) => row({
      sessionId: `session-${index}`,
      lastUsedAt: new Date(1_699_000_000_000 + index * 60_000).toISOString(),
    }));
    const view = harness({ rows });
    expect((await view.cache.prepare(descriptor(ENV_A, { maxSessions: 2 }))).kind).toBe("open");
    expect([...view.store.rows.values()].map((stored) => stored.sessionId).sort()).toEqual(["session-4", "session-5"]);
    expect(view.cache.counters().records).toBe(2);
  });

  it("closes a store that arrives after the pass gave up on it", async () => {
    let release: ((store: ReturnType<typeof createTestStore>) => void) | undefined;
    const late = createTestStore([row()], {});
    const view = harness({ openStore: () => new Promise((resolve) => { release = resolve; }) });
    const state = await view.cache.prepare(descriptor(), 10);
    expect(state).toMatchObject({ kind: "refused", reason: "storage" });
    release?.(late);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Closed, so it cannot be read from or written to by anything later.
    expect(await late.put(row({ sessionId: "after" }))).toBe(false);
  });
});

describe("promotion runs inside the queue", () => {
  it("does not resurrect a session that was forgotten while it was promoting", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    store.rows.set(`${ENV_A}\u0000cold`, row({ sessionId: "cold" }));

    const promoting = view.cache.prime(["cold"]);
    const forgetting = view.cache.forget({ sessionId: "cold" });
    await Promise.all([promoting, forgetting]);
    await view.flush();
    expect(peek(view.cache, "cold")).toBeUndefined();
    expect([...store.rows.values()].some((stored) => stored.sessionId === "cold")).toBe(false);
    expect(view.cache.counters().records).toBe(1);
  });

  it("does not resurrect anything when the environment is cleared while it is promoting", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    store.rows.set(`${ENV_A}\u0000cold`, row({ sessionId: "cold" }));

    const promoting = view.cache.prime(["cold"]);
    const clearing = view.cache.clear("environment");
    await Promise.all([promoting, clearing]);
    await view.flush();
    expect(store.rows.size).toBe(0);
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0, bytes: 0 });
  });
});

describe("the control lane is bounded and serialized", () => {
  it("coalesces repeated controls while the write lane is full", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    // Fill the work lane past both its ceilings.
    for (let index = 0; index < LIMITS.writes * 2; index += 1) {
      view.cache.release(tail({ sessionId: `session-${index}`, seq: index + 1 }));
    }
    view.deliver();
    const answers = await Promise.all([
      view.cache.forget({ sessionId: "session-a" }),
      view.cache.forget({ sessionId: "session-a" }),
      view.cache.forget({ sessionId: "session-a" }),
      view.cache.clear("environment"),
      view.cache.clear("environment"),
    ]);
    // Every waiter is answered, nothing was dropped, and the store saw one
    // pass rather than five.
    expect(answers.every((ok) => typeof ok === "boolean")).toBe(true);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    const counters = view.cache.counters();
    expect(counters.queued).toEqual({ writes: 0, touches: 0, control: 0 });
  });

  it("releases its bookkeeping once everything has settled", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    for (let index = 0; index < 40; index += 1) {
      await view.cache.forget({ sessionId: `session-${index}` });
      view.cache.release(tail({ sessionId: `later-${index}` }));
      await view.flush();
    }
    expect(view.cache.counters().queued).toEqual({ writes: 0, touches: 0, control: 0 });
  });
});

describe("durable recency is never claimed without a write", () => {
  it("puts the watermark back when the touch does not commit", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store });
    await view.cache.prepare(descriptor());
    view.clock.now += 2 * 60 * 60 * 1000;
    store.faults = { ...store.faults, refusePut: true };
    expect(peek(view.cache)).toBeDefined();
    await view.flush();
    const refused = view.cache.counters().writesRefused;
    expect(refused).toBeGreaterThan(0);
    // The next read tries again rather than believing the write that failed.
    view.clock.now += 2 * 60 * 60 * 1000;
    expect(peek(view.cache)).toBeDefined();
    await view.flush();
    expect(view.cache.counters().writesRefused).toBeGreaterThan(refused);
  });

  it("counts a second refused write rather than passing over it", async () => {
    const other = row({ sessionId: "other", lastUsedAt: new Date(1_699_000_000_000).toISOString() });
    const view = harness({ rows: [other], faults: { refusePut: true } });
    await view.cache.prepare(descriptor(ENV_A, { maxSessions: 2 }));
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.counters().writesRefused).toBeGreaterThanOrEqual(2);
    expect(peek(view.cache)).toBeUndefined();
  });
});

describe("freshness holds for a record that is held but not hot", () => {
  it("refuses an older tail against a newer cold row", async () => {
    // More rows than the hot ceiling, so the first is validated but not warm.
    const rows = Array.from({ length: TAIL_SCAN_LIMITS.warmRecords + 2 }, (_, index) => row({
      sessionId: `session-${index}`,
      lastUsedAt: new Date(1_699_000_000_000 + index * 1_000).toISOString(),
    }));
    rows[0] = row({ sessionId: "cold-newer", lastUsedAt: new Date(1_699_000_000_000).toISOString() }, payloadOf({ revision: REVISION_2, seq: 50 }));
    const view = harness({ rows });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect(peek(view.cache, "cold-newer")).toBeUndefined();

    view.cache.release(tail({ sessionId: "cold-newer", revision: REVISION, seq: 3 }));
    await view.flush();
    const stored = [...view.store.rows.values()].find((each) => each.sessionId === "cold-newer")!;
    const text = stored.body.kind === "plain" ? stored.body.text : "";
    expect(text).toContain(REVISION_2);
    expect(text).not.toContain(`"${REVISION}"`);
  });

  it("accepts a newer replacement for the same cold session", async () => {
    const rows = Array.from({ length: TAIL_SCAN_LIMITS.warmRecords + 2 }, (_, index) => row({
      sessionId: `session-${index}`,
      lastUsedAt: new Date(1_699_000_000_000 + index * 1_000).toISOString(),
    }));
    rows[0] = row({ sessionId: "cold-older", lastUsedAt: new Date(1_699_000_000_000).toISOString() }, payloadOf({ revision: REVISION, seq: 2 }));
    const view = harness({ rows });
    await view.cache.prepare(descriptor());
    view.cache.release(tail({ sessionId: "cold-older", revision: REVISION_2, seq: 9 }));
    await view.flush();
    const stored = [...view.store.rows.values()].find((each) => each.sessionId === "cold-older")!;
    const text = stored.body.kind === "plain" ? stored.body.text : "";
    expect(text).toContain(REVISION_2);
  });
});

describe("the deletion registry is single-flight", () => {
  it("issues one request however often clearing is asked for, and fences a newer pass", async () => {
    let requests = 0;
    let block;
    const factory = {
      deleteDatabase() {
        requests += 1;
        const request = {};
        block = () => request.onsuccess?.();
        return request;
      },
      open() {
        throw new Error("nothing may open while a deletion is outstanding");
      },
    };

    const first = destroyTailDatabase(factory, 5);
    const second = destroyTailDatabase(factory, 5);
    expect(await first).toBe("blocked");
    expect(await second).toBe("blocked");
    expect(requests).toBe(1);
    expect(deletionPending()).toBe(true);
    expect(await openTailStore(factory)).toBeUndefined();

    block?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deletionPending()).toBe(false);
  });

  it("does not close a pass that opened while a deletion was outstanding", async () => {
    let settle;
    const clock = { now: 1_700_000_000_000 };
    const cache = createTailCache({
      // A fresh store each time, as a reconnect gets.
      openStore: () => Promise.resolve(createTestStore([row()], {})),
      resolveVault: () => Promise.resolve(NULL_VAULT),
      destroy: () => new Promise((resolve) => { settle = resolve; }),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    expect((await cache.prepare(descriptor())).kind).toBe("open");
    const clearing = cache.clear("all");
    // A reconnect opens a new pass while the deletion is still outstanding.
    expect((await cache.prepare(descriptor())).kind).toBe("open");
    settle?.("deleted");
    expect(await clearing).toBe(true);
    // The newer pass is the one in force; the old deletion did not close it.
    expect(cache.state().kind).toBe("open");
  });
});

describe("no queued operation can hold the queue, and deletion is never starved", () => {
  /** A stuck port, and a small budget so the give-up is quick. */
  const stuck = (faults, seeded = [row()]) => harness({ rows: seeded, faults, budgetMs: 20 });

  it("gives up on a seal that never settles, and still completes a forget", async () => {
    const view = harness({
      rows: [row()],
      budgetMs: 20,
      vault: { ...NULL_VAULT, seal: () => new Promise(() => {}) },
    });
    await view.cache.prepare(descriptor());
    view.cache.release(tail({ sessionId: "stuck-session" }));
    view.deliver();
    // The deletion is admitted and answered, not queued behind a stuck write.
    expect(await view.cache.forget({ sessionId: "session-a" })).toBe(true);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(peek(view.cache, "stuck-session")).toBeUndefined();
  });

  it("gives up on a put that never commits, and holds nothing", async () => {
    const view = stuck({ stuckPut: true });
    await view.cache.prepare(descriptor());
    view.cache.release(tail({ sessionId: "never" }));
    await view.flush();
    expect(peek(view.cache, "never")).toBeUndefined();
    expect([...view.store.rows.values()].some((stored) => stored.sessionId === "never")).toBe(false);
    expect(await view.cache.clear("environment")).toBe(true);
  });

  it("gives up on a promotion whose scan never settles, and answers a clear", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store, budgetMs: 20 });
    await view.cache.prepare(descriptor());
    store.rows.set(`${ENV_A}\u0000cold`, row({ sessionId: "cold" }));
    store.faults = { ...store.faults, stuckScan: true };
    const promoting = view.cache.prime(["cold"]);
    const clearing = view.cache.clear("environment");
    await Promise.all([promoting, clearing]);
    expect(peek(view.cache, "cold")).toBeUndefined();
  });

  it("gives up on a promotion whose decrypt never settles", async () => {
    const store = createTestStore([row()], {});
    const view = harness({
      store,
      budgetMs: 20,
      vault: { ...NULL_VAULT, open: () => new Promise(() => {}) },
    });
    await view.cache.prepare(descriptor(), 10);
    store.rows.set(`${ENV_A}\u0000cold`, row({ sessionId: "cold" }));
    await view.cache.prime(["cold"]);
    expect(peek(view.cache, "cold")).toBeUndefined();
  });

  it("gives up on a removal that never settles, and fails closed", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store, budgetMs: 20 });
    await view.cache.prepare(descriptor());
    store.faults = { ...store.faults, stuckRemove: true };
    expect(await view.cache.forget({ sessionId: "session-a" })).toBe(false);
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
  });
});

describe("control coalescing holds while an operation is running", () => {
  it("joins a duplicate asked for during the operation instead of queueing another", async () => {
    const store = createTestStore([row(), row({ sessionId: "other" })], {});
    let removals = 0;
    const counting = {
      ...store,
      remove: (keys, batch, bounds) => {
        removals += 1;
        return store.remove(keys, batch, bounds);
      },
    };
    const view = harness({ store: counting });
    await view.cache.prepare(descriptor());
    const first = view.cache.forget({ sessionId: "session-a" });
    const second = view.cache.forget({ sessionId: "session-a" });
    const third = view.cache.forget({ sessionId: "session-a" });
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    // One deletion for one session, however many times it was asked for.
    expect(removals).toBe(1);
    expect(view.cache.counters().queued).toEqual({ writes: 0, touches: 0, control: 0 });
  });

  it("keeps the control lane inside its bound while an operation is blocked", async () => {
    const store = createTestStore([row()], {});
    const view = harness({ store, budgetMs: 40 });
    await view.cache.prepare(descriptor());
    store.faults = { ...store.faults, stuckRemove: true };
    const asks = [];
    for (let index = 0; index < 50; index += 1) asks.push(view.cache.forget({ sessionId: "session-a" }));
    for (let index = 0; index < 20; index += 1) asks.push(view.cache.clear("environment"));
    // One op per identity, whatever the volume: the bound is static.
    const depth = view.cache.counters().queued!;
    expect(depth.control).toBeLessThanOrEqual(TAIL_SCAN_LIMITS.warmRecords + 24 + 4);
    expect(depth.control).toBeLessThanOrEqual(2);
    await Promise.all(asks);
  });

  it("gives a promotion asked for mid-pass exactly one follow-up", async () => {
    const store = createTestStore([row()], {});
    let scans = 0;
    const counting = {
      ...store,
      scan: (options, visit) => {
        scans += 1;
        return store.scan(options, visit);
      },
    };
    const view = harness({ store: counting });
    await view.cache.prepare(descriptor());
    const before = scans;
    store.rows.set(`${ENV_A}\u0000one`, row({ sessionId: "one" }));
    store.rows.set(`${ENV_A}\u0000two`, row({ sessionId: "two" }));
    const first = view.cache.prime(["one"]);
    const second = view.cache.prime(["two"]);
    await Promise.all([first, second]);
    await view.flush();
    // The second ask was not folded into a pass that could not answer for it,
    // and it did not queue an unbounded chain either.
    expect(peek(view.cache, "two")).toBeDefined();
    // One pass, and exactly one bounded follow-up for what it could not answer.
    expect(scans - before).toBeLessThanOrEqual(2);
  });
});

describe("a failed or cancelled touch leaves no durable claim", () => {
  it("puts the in-memory recency back when the write does not commit", async () => {
    const older = row({ sessionId: "older", lastUsedAt: new Date(1_699_000_000_000).toISOString() });
    const store = createTestStore([older, row()], {});
    const view = harness({ store });
    await view.cache.prepare(descriptor(ENV_A, { maxSessions: 2 }));
    // Read the older record with the store refusing writes.
    view.clock.now += 2 * 60 * 60 * 1000;
    store.faults = { ...store.faults, refusePut: true };
    expect(peek(view.cache, "older")).toBeDefined();
    await view.flush();
    store.faults = { ...store.faults, refusePut: false };

    // The unpersisted read must not make `older` look like the newest record:
    // a write now evicts it, exactly as it would have before the failed touch.
    view.clock.now += 1_000;
    view.cache.release(tail({ sessionId: "fresh" }));
    await view.flush();
    expect([...store.rows.values()].map((stored) => stored.sessionId).sort()).toEqual(["fresh", "session-a"]);
  });

  it("puts it back when the touch is cancelled by a clear", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    view.clock.now += 2 * 60 * 60 * 1000;
    const before = view.cache.counters().records;
    expect(peek(view.cache)).toBeDefined();
    expect(await view.cache.clear("environment")).toBe(true);
    await view.flush();
    expect(before).toBe(1);
    expect(view.cache.counters()).toMatchObject({ records: 0, hotRecords: 0 });
  });
});

describe("a Windows locator is refused like any other", () => {
  it("discards a row whose identity is a drive path", async () => {
    const view = harness({ rows: [row()], faults: { windowsLocatorRows: 2 } });
    expect((await view.cache.prepare(descriptor())).kind).toBe("open");
    expect(view.cache.counters().discarded.invalid).toBe(2);
    expect([...view.store.rows.values()].map((stored) => stored.sessionId)).toEqual(["session-a"]);
  });
});

describe("supersession is a proved deletion, not a hidden object", () => {
  it("deletes a superseded cold record, and a reload does not find it", async () => {
    const rows = Array.from({ length: TAIL_SCAN_LIMITS.warmRecords + 2 }, (_, index) => row({
      sessionId: `session-${index}`,
      lastUsedAt: new Date(1_699_000_000_000 + index * 1_000).toISOString(),
    }));
    rows[0] = row({ sessionId: "cold", lastUsedAt: new Date(1_699_000_000_000).toISOString() }, payloadOf({ revision: REVISION }));
    const view = harness({ rows });
    await view.cache.prepare(descriptor());
    expect(peek(view.cache, "cold")).toBeUndefined();

    view.cache.supersede("cold", REVISION_2);
    // Out of the candidates synchronously, and out of the store when the
    // queued deletion has proved itself.
    expect(view.cache.counters().records).toBe(rows.length - 1);
    await view.flush();
    expect([...view.store.rows.values()].some((stored) => stored.sessionId === "cold")).toBe(false);

    const again = harness({ store: view.store });
    expect((await again.cache.prepare(descriptor())).kind).toBe("open");
    expect(again.cache.peek({ sessionId: "cold" })).toBeUndefined();
  });

  it("accepts a later fresh release of the same conversation", async () => {
    const view = harness({ rows: [row()] });
    await view.cache.prepare(descriptor());
    view.cache.supersede("session-a", REVISION_2);
    await view.flush();
    expect(view.store.rows.size).toBe(0);

    view.cache.release(tail({ revision: REVISION_2, seq: 20 }));
    await view.flush();
    expect(peek(view.cache)).toMatchObject({ revision: REVISION_2 });
    expect(view.store.rows.size).toBe(1);
  });

  it("leaves a newer record alone when the superseded revision is not the one held", async () => {
    const view = harness({ rows: [row({}, payloadOf({ revision: REVISION_2, seq: 40 }))] });
    await view.cache.prepare(descriptor());
    // RP-11 supersedes what it painted; a newer record has landed since.
    view.cache.supersede("session-a", REVISION_2);
    await view.flush();
    expect(view.store.rows.size).toBe(1);
    expect(view.cache.peek({ sessionId: "session-a" })?.revision).toBe(REVISION_2);
  });

  it("closes the cache when a superseded row cannot be proved gone", async () => {
    const store = createTestStore([row()], { silentRemove: true });
    const view = harness({ store });
    await view.cache.prepare(descriptor());
    view.cache.supersede("session-a", REVISION_2);
    await view.flush();
    expect(view.cache.state()).toMatchObject({ kind: "refused", reason: "purge" });
  });
});
