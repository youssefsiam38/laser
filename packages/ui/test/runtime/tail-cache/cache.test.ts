/**
 * The device tail cache: admission, identity, bounds, damage and fences
 * (RP-10, M18-T10).
 *
 * Everything here runs against the real authority. What is faked is the
 * browser: an in-memory store under `test/` (never in `src/`), a clock, and a
 * vault with either no key or a real WebCrypto key behind a fake desktop
 * bridge. The IndexedDB implementation itself is proven in the browser matrix,
 * because neither happy-dom nor Node has a database to prove it against.
 */
import { DEFAULT_CACHE_POLICY, PRODUCT_VERSION, type CachePolicy, type EnvironmentDescriptor } from "@lasercode/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTailCache, type TailCache, type TailCacheState } from "../../../src/runtime/tail-cache/cache.js";
import { TAIL_HARD_LIMITS, TAIL_RECORD_SCHEMA, TAIL_SCAN_LIMITS, boundsFor } from "../../../src/runtime/tail-cache/bounds.js";
import { TAIL_OMITTED_ATTACHMENT, bodyText, bodyTextBytes, checksumOf, identityAad } from "../../../src/runtime/tail-cache/record.js";
import type { TailRow } from "../../../src/runtime/tail-cache/store.js";
import { NULL_VAULT, createDesktopVault, type TailVault } from "../../../src/runtime/tail-cache/vault.js";
import { VIEW_TAIL_SCHEMA, type ViewTailDto } from "../../../src/runtime/view-tail.js";
import { createMemoryTailStore, type MemoryStoreFaults, type MemoryTailStore } from "./memory-store.js";

const ENV_A = "e1.AAAAAAAAAAAAAAAAAAAAAA";
const ENV_B = "e1.BBBBBBBBBBBBBBBBBBBBBB";
const REVISION = "r1.abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REVISION_2 = "r1.abcdefgh.BBBBBBBBBBBBBBBBBBBBBBBBBBB";

function descriptor(environmentKey = ENV_A, cache: Partial<CachePolicy> = {}): EnvironmentDescriptor {
  return {
    contract: "ep1",
    version: PRODUCT_VERSION,
    environmentKey,
    deployment: "local",
    actor: { class: "local_browser", id: "actor" },
    capabilities: { revisions: true, deltas: true, snapshots: true, durableReads: true, search: true, diagnostics: true, logs: true, push: false },
    cache: { ...DEFAULT_CACHE_POLICY, ...cache },
    scopes: [],
    localOnly: [],
  };
}

const entry = (id: string, text = "hello", parentId: string | null = null) => ({
  id,
  parentId,
  json: JSON.stringify({ id, parentId, type: "message", message: { role: "user", content: [{ type: "text", text }] } }),
});

function tail(overrides: Partial<ViewTailDto> = {}): ViewTailDto {
  return Object.freeze({
    schema: VIEW_TAIL_SCHEMA,
    path: "/p/a.jsonl",
    sessionId: "session-a",
    environmentKey: ENV_A,
    revision: REVISION,
    epoch: "epoch-1",
    seq: 7,
    leafId: "e2",
    capturedAt: new Date(1_700_000_000_000).toISOString(),
    entries: Object.freeze([entry("e1"), entry("e2", "world", "e1")]),
    truncated: false,
    bytes: 200,
    ...overrides,
  }) as ViewTailDto;
}

interface Harness {
  cache: TailCache;
  store: MemoryTailStore;
  clock: { now: number };
  /** Every deferred write, run in order. */
  flush(): Promise<void>;
  deferred: number;
}

function harness(options: {
  rows?: readonly TailRow[];
  faults?: MemoryStoreFaults;
  vault?: TailVault;
  noStore?: boolean;
  appVersion?: string;
} = {}): Harness {
  const clock = { now: 1_700_000_000_000 };
  const store = createMemoryTailStore(options.rows ?? [], options.faults ?? {}, clock);
  const tasks: Array<() => void> = [];
  const cache = createTailCache({
    openStore: () => Promise.resolve(options.noStore ? undefined : store),
    resolveVault: () => Promise.resolve(options.vault ?? NULL_VAULT),
    destroy: () => Promise.resolve("deleted"),
    appVersion: options.appVersion ?? PRODUCT_VERSION,
    now: () => clock.now,
    defer: (task) => tasks.push(task),
  });
  const view: Harness = {
    cache,
    store,
    clock,
    get deferred() {
      return tasks.length;
    },
    async flush() {
      // Two rounds: a write chain can schedule its own eviction.
      for (let round = 0; round < 3; round += 1) {
        const batch = tasks.splice(0, tasks.length);
        for (const task of batch) task();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
  return view;
}

/** One stored row, written the way the cache writes them. */
function row(overrides: Partial<TailRow> = {}): TailRow {
  const body = { entries: [entry("e1")], attachments: [] };
  const text = bodyText(body);
  const base: TailRow = {
    schema: TAIL_RECORD_SCHEMA,
    appVersion: PRODUCT_VERSION,
    environmentKey: ENV_A,
    sessionId: "session-a",
    path: "/p/a.jsonl",
    revision: REVISION,
    leafId: "e1",
    epoch: "epoch-1",
    seq: 3,
    truncated: false,
    attachments: [],
    attachmentsOmitted: 0,
    // Exact UTF-8 bytes of the body as stored: a row whose number disagrees
    // with its body is corrupt, which is its own test below.
    bytes: bodyTextBytes(text),
    capturedAt: new Date(1_699_999_000_000).toISOString(),
    lastUsedAt: new Date(1_699_999_000_000).toISOString(),
    checksum: checksumOf(text),
    body: { kind: "plain", text },
    ...overrides,
  };
  return base;
}

async function prepared(view: Harness, environment = descriptor()): Promise<TailCacheState> {
  return view.cache.prepare(environment);
}

describe("admission comes from the environment's validated policy, and nowhere else", () => {
  it("opens with the policy's bounds narrowed by this device's own ceilings", async () => {
    const view = harness();
    const state = await prepared(view, descriptor(ENV_A, { maxSessions: 4, maxBytes: 1024, maxEntriesPerSession: 3, maxAgeHours: 1 }));
    expect(state.kind).toBe("open");
    expect(view.cache.state()).toMatchObject({ kind: "open", environmentKey: ENV_A });
    expect(view.cache.counters().bounds).toEqual(boundsFor({ ...DEFAULT_CACHE_POLICY, maxSessions: 4, maxBytes: 1024, maxEntriesPerSession: 3, maxAgeHours: 1 }));
  });

  it("refuses content the environment forbids, and deletes what is already there", async () => {
    const view = harness({ rows: [row()] });
    const state = await prepared(view, descriptor(ENV_A, { transcripts: "disabled" }));
    expect(state).toMatchObject({ kind: "refused", reason: "policy" });
    expect(view.store.rows.size).toBe(0);
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("refuses a policy whose limits are zero", async () => {
    const view = harness({ rows: [row()] });
    expect(await prepared(view, descriptor(ENV_A, { maxBytes: 0 }))).toMatchObject({ kind: "refused", reason: "bounds" });
    expect(view.store.rows.size).toBe(0);
  });

  it("refuses when the environment requires encryption this device cannot prove", async () => {
    const view = harness({ rows: [row()] });
    expect(await prepared(view, descriptor(ENV_A, { requireDeviceEncryption: true }))).toMatchObject({
      kind: "refused",
      reason: "encryption",
    });
    expect(view.store.rows.size).toBe(0);
  });

  it("accepts a required-encryption policy when an OS-backed key is real", async () => {
    const vault = await createDesktopVault(
      { key: () => Promise.resolve({ available: true, key: "A".repeat(43), store: "the system keyring" }), reset: () => Promise.reject(new Error("no")) },
      globalThis.crypto.subtle,
      (into) => globalThis.crypto.getRandomValues(into),
    );
    expect(vault.encrypted).toBe(true);
    const view = harness({ vault });
    expect(await prepared(view, descriptor(ENV_A, { requireDeviceEncryption: true }))).toMatchObject({ kind: "open" });
  });

  it("is closed before any environment, and reads nothing", () => {
    const view = harness();
    expect(view.cache.state()).toEqual({ kind: "closed" });
    view.cache.release(tail());
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.deferred).toBe(0);
  });
});

describe("no production store means no cache, never an in-memory one", () => {
  it("refuses storage, holds nothing, and leaves authoritative loading alone", async () => {
    const view = harness({ noStore: true });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "storage" });
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    const counters = view.cache.counters();
    expect(counters).toMatchObject({ status: "refused", refusal: "storage", records: 0, bytes: 0, hotRecords: 0, durable: false });
  });
});

describe("identity is opaque, and one environment never reads another's", () => {
  it("writes a record under (environmentKey, sessionId) and reads it back by path", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    const hit = view.cache.peek("/p/a.jsonl");
    expect(hit).toMatchObject({ sessionId: "session-a", environmentKey: ENV_A, revision: REVISION });
    await view.flush();
    const stored = [...view.store.rows.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ environmentKey: ENV_A, sessionId: "session-a", path: "/p/a.jsonl" });
  });

  it("purges another environment's rows before it opens, and never reads one", async () => {
    const foreign = row({ environmentKey: ENV_B, sessionId: "session-b", path: "/p/b.jsonl" });
    const view = harness({ rows: [foreign, row()] });
    await prepared(view);
    expect([...view.store.rows.values()].map((stored) => stored.environmentKey)).toEqual([ENV_A]);
    expect(view.cache.peek("/p/b.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.foreign).toBe(1);
  });

  it("refuses a released tail that belongs to another environment", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ environmentKey: ENV_B }));
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("keeps a record through a rename, because the session id is the identity", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    view.cache.release(tail({ path: "/p/renamed.jsonl", revision: REVISION_2, seq: 9 }));
    await view.flush();
    expect(view.store.rows.size).toBe(1);
    expect(view.cache.peek("/p/renamed.jsonl")).toMatchObject({ revision: REVISION_2 });
    // The old path no longer addresses anything, which is correct.
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("refuses a tail with no validated revision or no identity", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ omitted: "no-revision", entries: [] }));
    view.cache.release(tail({ revision: "not-a-revision" }));
    view.cache.release(tail({ sessionId: "" }));
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
  });

  it("refuses a tail carrying a field this build does not understand", async () => {
    const view = harness();
    await prepared(view);
    // RP-5 owns the released-tail shape and may add to it \u2014 a later slice
    // plans a marker for a tail whose oversized bodies were left out. A cache
    // that ignored the marker would file an excerpt as the whole conversation.
    view.cache.release({ ...tail(), bodies: "excerpt" } as unknown as ViewTailDto);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().writesRefused).toBe(1);

    // The same rule one level down, where an entry could gain a marker of its own.
    view.cache.release({ ...tail(), entries: [{ ...entry("e1"), excerpted: true }] } as unknown as ViewTailDto);
    await view.flush();
    expect(view.store.rows.size).toBe(0);

    // And the shape it does understand is still stored.
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(1);
  });

  it("does not let an older capture replace a newer one", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ seq: 9, revision: REVISION_2 }));
    await view.flush();
    view.cache.release(tail({ seq: 4, revision: REVISION }));
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toMatchObject({ revision: REVISION_2 });
    // Across worker generations `seq` restarts, so the capture time decides.
    view.cache.release(tail({ epoch: "epoch-2", seq: 1, revision: REVISION, capturedAt: new Date(1_699_000_000_000).toISOString() }));
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toMatchObject({ revision: REVISION_2 });
  });
});

describe("bounds: count, exact UTF-8 bytes, entries and age", () => {
  it("evicts least recently used first when the record count is over", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxSessions: 2 }));
    for (const index of [1, 2, 3]) {
      view.clock.now += 1000;
      view.cache.release(tail({ path: `/p/${index}.jsonl`, sessionId: `session-${index}` }));
      await view.flush();
    }
    expect([...view.store.rows.values()].map((stored) => stored.sessionId).sort()).toEqual(["session-2", "session-3"]);
    expect(view.cache.counters().evictions).toBeGreaterThan(0);
  });

  it("counts bytes as a quota counts them, not as string length", async () => {
    const view = harness();
    await prepared(view);
    const text = "日本語のテキスト";
    view.cache.release(tail({ entries: [entry("e1", text)] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    const expected = new TextEncoder().encode(record.entries[0]!.json).length;
    expect(record.bytes).toBeGreaterThanOrEqual(expected);
    expect(record.bytes).toBeGreaterThan(record.entries[0]!.json.length);
  });

  it("trims a tail to the policy's entry ceiling, keeping the newest", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxEntriesPerSession: 2 }));
    view.cache.release(tail({ entries: [entry("e1"), entry("e2"), entry("e3")] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    expect(record.entries.map((each) => each.id)).toEqual(["e2", "e3"]);
    expect(record.truncated).toBe(true);
  });

  it("drops a record whose per-record byte bound the policy narrowed under it", async () => {
    const big = row({ bytes: TAIL_HARD_LIMITS.bytesPerSession + 1 });
    const view = harness({ rows: [big] });
    await prepared(view);
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().discarded.oversize).toBe(1);
  });

  it("forgets a record older than the environment allows, and one dated in the future", async () => {
    const old = row({ sessionId: "old", path: "/p/old.jsonl", capturedAt: new Date(1_600_000_000_000).toISOString() });
    const ahead = row({ sessionId: "ahead", path: "/p/ahead.jsonl", capturedAt: new Date(1_800_000_000_000).toISOString() });
    const view = harness({ rows: [old, ahead] });
    await prepared(view);
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().discarded.expired).toBe(2);
  });

  it("stops answering a record that expires while it is held", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxAgeHours: 1 }));
    view.cache.release(tail());
    await view.flush();
    expect(view.cache.peek("/p/a.jsonl")).toBeDefined();
    view.clock.now += 2 * 60 * 60 * 1000;
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.expired).toBe(1);
  });
});

describe("damaged, incompatible and unreadable rows are discarded safely", () => {
  it("throws away every kind of damage, counts it, and still opens", async () => {
    const rows: TailRow[] = [
      row({ sessionId: "a", path: "/a", schema: "tail-cache/0" }),
      row({ sessionId: "b", path: "/b", appVersion: "0.0.0-other" }),
      row({ sessionId: "c", path: "/c", revision: "nonsense" }),
      row({ sessionId: "d", path: "/d", capturedAt: "not a date" }),
      row(),
    ];
    const view = harness({ rows });
    const state = await prepared(view);
    expect(state.kind).toBe("open");
    const counters = view.cache.counters();
    expect(counters.discarded).toMatchObject({ schema: 1, version: 1, invalid: 1, expired: 1 });
    expect([...view.store.rows.values()].map((stored) => stored.sessionId)).toEqual(["session-a"]);
  });

  it("discards a body whose checksum does not match what is stored", async () => {
    const corrupt = row({ checksum: "deadbeef-1" });
    const view = harness({ rows: [corrupt] });
    expect((await prepared(view)).kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.corrupt).toBe(1);
  });

  it("discards a body it cannot open, without ever reading a partial one", async () => {
    const vault: TailVault = { ...NULL_VAULT, encrypted: true, encryption: { kind: "os-backed", store: "the system keyring" }, open: () => Promise.resolve(undefined) };
    const view = harness({ rows: [row()], vault });
    expect((await prepared(view)).kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.undecryptable).toBe(1);
  });

  it("discards a body that is not the shape it claims", async () => {
    const text = JSON.stringify({ entries: [{ id: 5 }], attachments: [] });
    const view = harness({ rows: [row({ body: { kind: "plain", text }, checksum: checksumOf(text) })] });
    expect((await prepared(view)).kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.corrupt).toBe(1);
  });
});

describe("a ciphertext cannot be replayed under another identity", () => {
  it("refuses to open a body sealed for a different record", async () => {
    const vault = await createDesktopVault(
      { key: () => Promise.resolve({ available: true, key: "B".repeat(43), store: "the system keyring" }), reset: () => Promise.reject(new Error("no")) },
      globalThis.crypto.subtle,
      (into) => globalThis.crypto.getRandomValues(into),
    );
    const body = { entries: [entry("e1")], attachments: [] };
    const text = bodyText(body);
    const mine = row();
    const sealed = await vault.seal(text, identityAad(mine));
    expect(sealed).toBeDefined();
    // The same ciphertext, filed under another session.
    const stolen = row({ sessionId: "somebody-else", path: "/p/other.jsonl", body: sealed!, checksum: checksumOf(text) });
    const view = harness({ rows: [stolen], vault });
    expect((await prepared(view)).kind).toBe("open");
    expect(view.cache.peek("/p/other.jsonl")).toBeUndefined();
    expect(view.cache.counters().discarded.undecryptable).toBe(1);
  });
});

describe("writes are atomic, and a failed one changes nothing", () => {
  it("leaves the previous row in place when the transaction does not commit", async () => {
    const view = harness({ faults: { refusePut: true }, rows: [row()] });
    await prepared(view);
    view.cache.release(tail({ revision: REVISION_2, seq: 11 }));
    await view.flush();
    expect([...view.store.rows.values()][0]).toMatchObject({ revision: REVISION });
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
  });

  it("makes room once and retries when the first write is refused", async () => {
    const view = harness({ faults: { refuseFirstPuts: 1 } });
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(1);
  });
});

describe("attachments are references, never a second copy of a picture", () => {
  const picture = (id: string, bytes: number) => ({
    id,
    parentId: null,
    json: JSON.stringify({
      id,
      parentId: null,
      type: "message",
      message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(bytes) }] },
    }),
  });

  it("replaces an oversized picture with a bounded reference and a marker", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 20_000)] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments[0]).toMatchObject({ entryId: "e1", mimeType: "image/png", bytes: 20_000 });
    const part = JSON.parse(record.entries[0]!.json).message.content[0];
    expect(part.data).toBe("");
    expect(part[PRODUCT_NAME_KEY]).toEqual({ cached: TAIL_OMITTED_ATTACHMENT, bytes: 20_000 });
    expect(record.bytes).toBeLessThan(2_000);
  });

  it("keeps a small picture inline, because a reference would cost more", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 100)] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    expect(record.attachments).toHaveLength(0);
    expect(JSON.parse(record.entries[0]!.json).message.content[0].data).toBe("A".repeat(100));
  });

  it("keeps not even a reference when the policy says none", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { attachments: "none" }));
    view.cache.release(tail({ entries: [picture("e1", 20_000), picture("e2", 50)] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    expect(record.attachments).toHaveLength(0);
    expect(record.attachmentsOmitted).toBe(2);
    expect(JSON.parse(record.entries[0]!.json).message.content[0].data).toBe("");
  });

  it("never writes the same picture's bytes twice across two snapshots", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 20_000)] }));
    await view.flush();
    view.cache.release(tail({ revision: REVISION_2, seq: 8, entries: [picture("e1", 20_000), entry("e2")] }));
    await view.flush();
    const stored = [...view.store.rows.values()];
    expect(stored).toHaveLength(1);
    const text = stored[0]!.body.kind === "plain" ? stored[0]!.body.text : "";
    expect(text).not.toContain("AAAAAAAAAA");
  });

  it("drops an entry it cannot read rather than storing it raw", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [{ id: "e1", parentId: null, json: "{not json" }, entry("e2")] }));
    await view.flush();
    const record = view.cache.peek("/p/a.jsonl")!;
    expect(record.entries.map((each) => each.id)).toEqual(["e2"]);
    expect(record.truncated).toBe(true);
  });
});

describe("peek is synchronous, allocation-free and fenced", () => {
  it("returns the same frozen object on two hits", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    const first = view.cache.peek("/p/a.jsonl");
    const second = view.cache.peek("/p/a.jsonl");
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as unknown as { bytes: number }).bytes = 0;
    }).toThrow();
  });

  it("answers from the warm set the moment preparation resolves", async () => {
    const view = harness({ rows: [row()] });
    const state = await prepared(view);
    // This is the guarantee the connection waits for: readable *now*, before
    // anything is requested from the host.
    expect(state.kind).toBe("open");
    expect(view.cache.peek("/p/a.jsonl")).toMatchObject({ sessionId: "session-a", revision: REVISION });
  });

  it("stops offering a record RP-11 has replaced", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    view.cache.supersede("session-a", REVISION_2);
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("promotes a record on demand, bounded", async () => {
    const extra = row({ sessionId: "session-z", path: "/p/z.jsonl" });
    const view = harness({ rows: [extra] });
    await prepared(view);
    expect(view.cache.peek("/p/z.jsonl")).toBeDefined();
    view.cache.deactivate();
    expect(view.cache.peek("/p/z.jsonl")).toBeUndefined();
  });
});

describe("every asynchronous step is fenced to its generation", () => {
  it("drops a write whose environment went away", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    view.cache.deactivate();
    await view.flush();
    expect(view.store.rows.size).toBe(0);
  });

  it("drops a preparation whose environment was replaced under it", async () => {
    const clock = { now: 1_700_000_000_000 };
    const store = createMemoryTailStore([row()], {}, clock);
    let release: (() => void) | undefined;
    const cache = createTailCache({
      openStore: () => new Promise((resolve) => {
        release = () => resolve(store);
      }),
      resolveVault: () => Promise.resolve(NULL_VAULT),
      destroy: () => Promise.resolve("deleted"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    const first = cache.prepare(descriptor(ENV_A));
    cache.deactivate();
    release?.();
    await first;
    expect(cache.state()).toEqual({ kind: "closed" });
    expect(cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("never rejects, whatever the store does", async () => {
    const clock = { now: 1 };
    const cache = createTailCache({
      openStore: () => Promise.reject(new Error("no storage here")),
      resolveVault: () => Promise.reject(new Error("no vault either")),
      destroy: () => Promise.reject(new Error("nor that")),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    await expect(cache.prepare(descriptor())).resolves.toMatchObject({ kind: "refused", reason: "storage" });
    await expect(cache.clear("all")).resolves.toBe(false);
  });
});

describe("a hostile or enormous database fails closed", () => {
  const manyRows = (count: number): TailRow[] =>
    Array.from({ length: count }, (_, index) => row({ sessionId: `session-${index}`, path: `/p/${index}.jsonl` }));

  it("refuses when a pass would examine more rows than the ceiling allows", async () => {
    const view = harness({ rows: manyRows(TAIL_SCAN_LIMITS.scanRows + 1) });
    const state = await prepared(view);
    expect(state).toMatchObject({ kind: "refused", reason: "purge", stoppedBy: "over-rows" });
    expect(view.cache.peek("/p/1.jsonl")).toBeUndefined();
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(TAIL_SCAN_LIMITS.scanRows + 1);
    expect(view.cache.counters().stoppedBy).toBe("over-rows");
  });

  it("does not let a row's own claimed size exhaust the scan budget", async () => {
    // A row this build did not write can claim any size. If the scan believed
    // it, one hostile row would fail the pass closed for ever \u2014 and the delete
    // that removes it would never run. The claim is ignored; the row is
    // discarded for being over the per-record bound.
    const liar = row({ sessionId: "liar", path: "/p/liar.jsonl", bytes: 99_999_999 });
    const view = harness({ rows: [liar, row()] });
    const state = await prepared(view);
    expect(state.kind).toBe("open");
    expect(view.cache.counters().discarded.oversize).toBe(1);
    expect([...view.store.rows.values()].map((stored) => stored.sessionId)).toEqual(["session-a"]);
  });

  it("refuses when a pass would read more bytes than the ceiling allows", async () => {
    const heavy = Array.from({ length: 60 }, (_, index) => row({
      sessionId: `session-${index}`,
      path: `/p/${index}.jsonl`,
      body: { kind: "plain", text: "x".repeat(1024 * 1024) },
    }));
    const view = harness({ rows: heavy });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "purge", stoppedBy: "over-bytes" });
  });

  it("refuses when a pass runs out of its wall clock", async () => {
    const view = harness({ rows: manyRows(TAIL_SCAN_LIMITS.batchRows * 4), faults: { msPerBatch: TAIL_SCAN_LIMITS.prepareMs } });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "purge", stoppedBy: "over-time" });
  });

  it("refuses when a scan cannot be taken at all", async () => {
    const view = harness({ faults: { refuseScan: true } });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "storage" });
  });

  it("refuses when a delete reports success but the row is still there", async () => {
    const view = harness({ rows: [row({ environmentKey: ENV_B, sessionId: "other" })], faults: { silentRemove: true } });
    const state = await prepared(view);
    expect(state).toMatchObject({ kind: "refused", reason: "purge" });
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
  });

  it("does not retry a ceiling by itself, and recovers when the person clears", async () => {
    const view = harness({ rows: manyRows(TAIL_SCAN_LIMITS.scanRows + 1) });
    await prepared(view);
    const scans = view.store.transactions.scan;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.store.transactions.scan).toBe(scans);
    expect(await view.cache.clear("all")).toBe(true);
  });

  it("deletes and scans in bounded batches with a yield between them", async () => {
    const view = harness({ rows: manyRows(300) });
    await prepared(view, descriptor(ENV_A, { maxSessions: 1 }));
    expect(view.store.transactions.scan).toBe(Math.ceil(300 / TAIL_SCAN_LIMITS.batchRows));
    expect(view.store.transactions.remove).toBe(Math.ceil(299 / TAIL_SCAN_LIMITS.batchRows));
  });
});

describe("deleting, clearing and purging", () => {
  it("forgets one conversation's tail immediately", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    await view.cache.forget({ path: "/p/a.jsonl" });
    expect(view.cache.peek("/p/a.jsonl")).toBeUndefined();
    expect(view.store.rows.size).toBe(0);
  });

  it("clears this environment and says so", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    view.clock.now += 5_000;
    expect(await view.cache.clear("environment")).toBe(true);
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters()).toMatchObject({ records: 0, bytes: 0, lastClearedAt: new Date(view.clock.now).toISOString() });
  });

  it("does not claim a clear that did not happen", async () => {
    const view = harness({ rows: [row()], faults: { silentRemove: true } });
    await view.cache.prepare(descriptor(ENV_A));
    expect(await view.cache.clear("environment")).toBe(false);
  });

  it("clears everything by deleting the whole database, awaited", async () => {
    const destroy = vi.fn(() => Promise.resolve("deleted" as const));
    const clock = { now: 1 };
    const store = createMemoryTailStore([row()], {}, clock);
    const cache = createTailCache({
      openStore: () => Promise.resolve(store),
      resolveVault: () => Promise.resolve(NULL_VAULT),
      destroy,
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    await cache.prepare(descriptor());
    expect(await cache.clear("all")).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
    expect(cache.state()).toEqual({ kind: "closed" });
  });

  it("reports a blocked deletion rather than claiming success", async () => {
    const clock = { now: 1 };
    const cache = createTailCache({
      openStore: () => Promise.resolve(createMemoryTailStore([], {}, clock)),
      resolveVault: () => Promise.resolve(NULL_VAULT),
      destroy: () => Promise.resolve("blocked"),
      appVersion: PRODUCT_VERSION,
      now: () => clock.now,
      defer: (task) => task(),
    });
    await cache.prepare(descriptor());
    expect(await cache.clear("all")).toBe(false);
  });
});

describe("counters", () => {
  it("report exactly what is held, and map to the diagnostics store row", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    const counters = view.cache.counters();
    expect(counters).toMatchObject({ status: "open", records: 1, durable: true });
    expect(counters.bytes).toBeGreaterThan(0);
    expect(counters.hotRecords).toBe(1);
    expect(counters.encryption).toEqual({ kind: "not-applicable" });
    // The frozen snapshot is reused until a number moves.
    expect(view.cache.counters()).toBe(counters);
  });
});

/** The one product-namespaced key a cached entry carries. */
const PRODUCT_NAME_KEY = (await import("@lasercode/protocol")).MESSAGE_METADATA_NS;

beforeEach(() => {
  vi.useRealTimers();
});
