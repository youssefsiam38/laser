/**
 * The device tail cache: admission, identity, bounds, damage and counters
 * (RP-10, M18-T10).
 *
 * Everything here runs against the real authority. What is faked is the
 * browser: the bounded ports in `harness.ts`, a clock, and a vault with either
 * no key or a real WebCrypto key behind a fake desktop bridge. Real IndexedDB
 * semantics are proved in browser acceptance, where there is a browser.
 */
import { PRODUCT_VERSION, MESSAGE_METADATA_NS } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";

import { TAIL_HARD_LIMITS, TAIL_SCAN_LIMITS, boundsFor } from "../../../src/runtime/tail-cache/bounds.js";
import { TAIL_OMITTED_ATTACHMENT, payloadBytes } from "../../../src/runtime/tail-cache/record.js";
import { createDesktopVault, NULL_VAULT, type TailVault } from "../../../src/runtime/tail-cache/vault.js";
import type { ViewTailDto } from "../../../src/runtime/view-tail.js";
import {
  ENV_A,
  ENV_B,
  REVISION,
  REVISION_2,
  descriptor,
  entry,
  expectHolds,
  harness,
  payloadOf,
  picture,
  row,
  tail,
  type Harness,
} from "./harness.js";

const prepared = (view: Harness, environment = descriptor()) => view.cache.prepare(environment);
const peek = (view: Harness, sessionId = "session-a") => view.cache.peek({ sessionId });

describe("admission comes from the environment's validated policy, and nowhere else", () => {
  it("opens with the policy's bounds narrowed by this device's own ceilings", async () => {
    const view = harness();
    const state = await prepared(view, descriptor(ENV_A, { maxSessions: 4, maxBytes: 1024, maxEntriesPerSession: 3, maxAgeHours: 1 }));
    expect(state.kind).toBe("open");
    expect(view.cache.counters().bounds).toEqual(
      boundsFor({ ...descriptor().cache, maxSessions: 4, maxBytes: 1024, maxEntriesPerSession: 3, maxAgeHours: 1 }),
    );
  });

  it("refuses content the environment forbids, and deletes what is already there", async () => {
    const view = harness({ rows: [row()] });
    expect(await prepared(view, descriptor(ENV_A, { transcripts: "disabled" }))).toMatchObject({ kind: "refused", reason: "policy" });
    expect(view.store.rows.size).toBe(0);
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(peek(view)).toBeUndefined();
  });

  it("refuses a policy whose limits are zero", async () => {
    const view = harness({ rows: [row()] });
    expect(await prepared(view, descriptor(ENV_A, { maxBytes: 0 }))).toMatchObject({ kind: "refused", reason: "bounds" });
    expect(view.store.rows.size).toBe(0);
  });

  it("refuses when the environment requires encryption this device cannot prove", async () => {
    const view = harness({ rows: [row()] });
    expect(await prepared(view, descriptor(ENV_A, { requireDeviceEncryption: true }))).toMatchObject({ kind: "refused", reason: "encryption" });
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
    expect(peek(view)).toBeUndefined();
    expect(view.deferred()).toBe(0);
  });
});

describe("no production store means no cache, never an in-memory one", () => {
  it("refuses storage, holds nothing, and leaves authoritative loading alone", async () => {
    const view = harness({ noStore: true });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "storage" });
    view.cache.release(tail());
    await view.flush();
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters()).toMatchObject({ status: "refused", refusal: "storage", records: 0, bytes: 0, hotRecords: 0, durable: false });
  });
});

describe("identity is opaque, and it is all of it", () => {
  it("writes one record per session and reads it back by its own id", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    expect(peek(view)).toMatchObject({ sessionId: "session-a", environmentKey: ENV_A, revision: REVISION });
    const stored = [...view.store.rows.values()];
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0]!).sort()).toEqual(
      ["appVersion", "body", "bytes", "capturedAt", "environmentKey", "lastUsedAt", "schema", "sessionId"],
    );
  });

  it("keeps no path and nothing shaped like one", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ path: "/home/someone/projects/private/hidden/session-7.jsonl" }));
    await view.flush();
    const stored = JSON.stringify([...view.store.rows.values()]);
    expect(stored).not.toContain("/home/someone");
    expect(stored).not.toContain(".jsonl");
    expect(stored).not.toContain("path");
    // Not even inside the sealed payload, where it is not needed.
    expect(stored).not.toMatch(/\/[a-z]+\//);
  });

  it("purges another environment's rows before it opens, and never reads one", async () => {
    const view = harness({ rows: [row({ environmentKey: ENV_B, sessionId: "session-b" }), row()] });
    await prepared(view);
    expect([...view.store.rows.values()].map((stored) => stored.environmentKey)).toEqual([ENV_A]);
    expect(peek(view, "session-b")).toBeUndefined();
    expect(view.cache.counters().discarded.foreign).toBe(1);
  });

  it("refuses a released tail that belongs to another environment", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ environmentKey: ENV_B }));
    await view.flush();
    expect(view.store.rows.size).toBe(0);
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
    // RP-5 owns the released-tail shape and may add to it — a later slice plans
    // a marker for a tail whose oversized bodies were left out. A cache that
    // ignored the marker would file an excerpt as the whole conversation.
    view.cache.release({ ...tail(), bodies: "excerpt" } as unknown as ViewTailDto);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().writesRefused).toBe(1);
    view.cache.release({ ...tail(), entries: [{ ...entry("e1"), excerpted: true }] } as unknown as ViewTailDto);
    await view.flush();
    expect(view.store.rows.size).toBe(0);
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
    expect(peek(view)).toMatchObject({ revision: REVISION_2 });
    // Across engine generations `seq` restarts, so the capture time decides.
    view.cache.release(tail({ epoch: "epoch-2", seq: 1, revision: REVISION, capturedAt: new Date(1_699_000_000_000).toISOString() }));
    await view.flush();
    expect(peek(view)).toMatchObject({ revision: REVISION_2 });
  });
});

describe("bounds: count, exact UTF-8 bytes, entries and age", () => {
  it("evicts least recently used first when the record count is over", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxSessions: 2 }));
    for (const index of [1, 2, 3]) {
      view.clock.now += 1000;
      view.cache.release(tail({ sessionId: `session-${index}` }));
      await view.flush();
    }
    expectHolds(view, ["session-2", "session-3"]);
    expect(view.cache.counters().evictions).toBeGreaterThan(0);
  });

  it("measures the payload that is written, ids, wrappers and escaping included", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [entry("e1", 'これは"引用"です 🌋')] }));
    await view.flush();
    const record = peek(view)!;
    const stored = [...view.store.rows.values()][0]!;
    const text = stored.body.kind === "plain" ? stored.body.text : "";
    expect(record.bytes).toBe(new TextEncoder().encode(text).length);
    expect(record.bytes).toBe(stored.bytes);
    expect(record.bytes).toBeGreaterThan(text.length);
    expect(view.cache.counters().bytes).toBe(record.bytes);
  });

  it("fits the canonical payload, not a sum of its entries", async () => {
    const bytesPerSession = 8_192;
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxBytes: bytesPerSession }));
    const longId = (index: number) => `entry-${"x".repeat(180)}-${index}`;
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: longId(index),
      parentId: index === 0 ? null : longId(index - 1),
      json: JSON.stringify({ id: longId(index), type: "message", message: { role: "user", content: [{ type: "text", text: `"引用" ${"日本語".repeat(40)}` }] } }),
    }));
    view.cache.release(tail({ entries: Object.freeze(rows) }));
    await view.flush();
    const record = peek(view)!;
    expect(record.bytes).toBeLessThanOrEqual(bytesPerSession);
    expect(record.truncated).toBe(true);
    // And the next start keeps it rather than purging what was just written.
    const again = harness({ store: view.store });
    expect((await again.cache.prepare(descriptor(ENV_A, { maxBytes: bytesPerSession }))).kind).toBe("open");
    expect(again.cache.peek({ sessionId: "session-a" })?.bytes).toBe(record.bytes);
    expect(again.cache.counters().discarded.oversize).toBe(0);
  });

  it("refuses a single entry that cannot fit the bound on its own", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxBytes: 512 }));
    view.cache.release(tail({ entries: [entry("e1", "あ".repeat(2_000))] }));
    await view.flush();
    expect(peek(view)).toBeUndefined();
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().writesRefused).toBe(1);
  });

  it("trims a tail to the policy's entry ceiling, keeping the newest", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { maxEntriesPerSession: 2 }));
    view.cache.release(tail({ entries: [entry("e1"), entry("e2"), entry("e3")] }));
    await view.flush();
    const record = peek(view)!;
    expect(record.entries.map((each) => each.id)).toEqual(["e2", "e3"]);
    expect(record.truncated).toBe(true);
  });

  it("drops a record whose per-record byte bound the policy narrowed under it", async () => {
    const big = payloadOf({ entries: [entry("e1", "x".repeat(TAIL_HARD_LIMITS.bytesPerSession))] });
    const view = harness({ rows: [row({}, big)] });
    await prepared(view);
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().discarded.oversize).toBe(1);
  });

  it("forgets a record older than the environment allows, and one dated in the future", async () => {
    const old = row({ sessionId: "old", capturedAt: new Date(1_600_000_000_000).toISOString() });
    const ahead = row({ sessionId: "ahead", capturedAt: new Date(1_800_000_000_000).toISOString() });
    const view = harness({ rows: [old, ahead] });
    await prepared(view);
    expect(view.store.rows.size).toBe(0);
    expect(view.cache.counters().discarded.expired).toBe(2);
  });
});

describe("damaged, incompatible and unreadable rows are discarded safely", () => {
  it("throws away every kind of damage, counts it, and still opens", async () => {
    const good = row();
    const view = harness({
      rows: [
        row({ sessionId: "a", schema: "tail-cache/1" }),
        row({ sessionId: "b", appVersion: "0.0.0-other" }),
        row({ sessionId: "c", capturedAt: "not a date" }),
        row({ sessionId: "d", bytes: 3 }),
        good,
      ],
    });
    expect((await prepared(view)).kind).toBe("open");
    const counters = view.cache.counters();
    expect(counters.discarded).toMatchObject({ schema: 1, version: 1, invalid: 1, corrupt: 1 });
    expect([...view.store.rows.values()].map((stored) => stored.sessionId)).toEqual(["session-a"]);
  });

  it("discards a body whose checksum does not match its content", async () => {
    const payload = payloadOf();
    const tampered = payload.text.replace("hello", "hellp");
    const view = harness({ rows: [row({ bytes: payloadBytes(tampered), body: { kind: "plain", text: tampered } })] });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().discarded.corrupt).toBe(1);
  });

  it("discards a body it cannot open, without ever reading a partial one", async () => {
    const vault: TailVault = { ...NULL_VAULT, encrypted: true, encryption: { kind: "os-backed", store: "the system keyring" }, open: () => Promise.resolve(undefined) };
    const view = harness({ rows: [row()], vault });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().discarded.undecryptable).toBe(1);
  });

  it("discards a body that is not the shape it claims", async () => {
    const text = JSON.stringify({ v: 2, content: { entries: [{ id: 5 }], attachments: [] } });
    const view = harness({ rows: [row({ bytes: payloadBytes(text), body: { kind: "plain", text } })] });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().discarded.corrupt).toBe(1);
  });

  it("refuses to warm a row that claims to be tiny and carries a huge body", async () => {
    const huge = payloadOf({ entries: [entry("e1", "あ".repeat(200_000))] });
    const view = harness({ rows: [row({ bytes: 12 }, huge)] });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().discarded.oversize).toBe(1);
    expect(view.store.rows.size).toBe(0);
  });
});

describe("a ciphertext cannot be replayed under another identity", () => {
  it("refuses to open a payload sealed for a different record", async () => {
    const vault = await createDesktopVault(
      { key: () => Promise.resolve({ available: true, key: "B".repeat(43), store: "the system keyring" }), reset: () => Promise.reject(new Error("no")) },
      globalThis.crypto.subtle,
      (into) => globalThis.crypto.getRandomValues(into),
    );
    const payload = payloadOf();
    const mine = row({}, payload);
    const sealed = await vault.seal(payload.text, [mine.schema, mine.appVersion, mine.environmentKey, mine.sessionId, mine.capturedAt].join("\u0000"));
    expect(sealed).toBeDefined();
    const stolen = row({ sessionId: "somebody-else", body: sealed!, bytes: payload.bytes });
    const view = harness({ rows: [stolen], vault });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view, "somebody-else")).toBeUndefined();
    expect(view.cache.counters().discarded.undecryptable).toBe(1);
  });

  it("puts no content-derived metadata in the clear beside the ciphertext", async () => {
    const vault = await createDesktopVault(
      { key: () => Promise.resolve({ available: true, key: "C".repeat(43), store: "the system keyring" }), reset: () => Promise.reject(new Error("no")) },
      globalThis.crypto.subtle,
      (into) => globalThis.crypto.getRandomValues(into),
    );
    const view = harness({ vault });
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 20_000), entry("e2", "secret words")] }));
    await view.flush();
    const [stored] = [...view.store.rows.values()];
    expect(stored?.body.kind).toBe("aes-gcm-256");
    const clear = JSON.stringify({ ...stored, body: { kind: stored!.body.kind } });
    for (const leak of ["image/png", "secret words", "checksum", "attachments", "revision", "leafId", "truncated"]) {
      expect(clear).not.toContain(leak);
    }
    // And it still decrypts and validates on the next start.
    const again = harness({ store: view.store, vault });
    expect((await again.cache.prepare(descriptor())).kind).toBe("open");
    const record = again.cache.peek({ sessionId: "session-a" })!;
    expect(record.attachments[0]).toMatchObject({ mimeType: "image/png", bytes: 20_000 });
    expect(record.revision).toBe(REVISION);
  });
});

describe("writes are atomic, and a failed one changes nothing", () => {
  it("leaves the previous row in place when the transaction does not commit", async () => {
    const view = harness({ faults: { refusePut: true }, rows: [row()] });
    await prepared(view);
    view.cache.release(tail({ revision: REVISION_2, seq: 11 }));
    await view.flush();
    const stored = [...view.store.rows.values()][0]!;
    const text = stored.body.kind === "plain" ? stored.body.text : "";
    expect(text).toContain(REVISION);
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
  });

  it("frees the oldest other record, proves it, and commits the retry", async () => {
    const older = row({ sessionId: "older", lastUsedAt: new Date(1_699_000_000_000).toISOString() });
    const newer = row({ sessionId: "newer", lastUsedAt: new Date(1_699_900_000_000).toISOString() });
    const view = harness({ rows: [older, newer], faults: { capacity: 2 } });
    expect((await prepared(view, descriptor(ENV_A, { maxSessions: 4 }))).kind).toBe("open");
    view.clock.now += 1_000;
    view.cache.release(tail());
    await view.flush();
    expectHolds(view, ["newer", "session-a"]);
    expect(peek(view)).toBeDefined();
    expect(view.cache.counters().evictions).toBe(1);
  });

  it("gives up rather than pretending, when there is nothing left to free", async () => {
    const view = harness({ faults: { refuseFirstPuts: 1 } });
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    expect(view.store.rows.size).toBe(0);
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().writesRefused).toBeGreaterThan(0);
  });

  it("keeps the durable row it already had when the retry cannot commit", async () => {
    const previous = row({}, payloadOf({ revision: REVISION_2 }));
    const other = row({ sessionId: "other", lastUsedAt: new Date(1_699_000_000_000).toISOString() });
    const view = harness({ rows: [previous, other], faults: { refuseFirstPuts: 2 } });
    expect((await prepared(view, descriptor(ENV_A, { maxSessions: 4 }))).kind).toBe("open");
    view.clock.now += 1_000;
    view.cache.release(tail({ revision: REVISION, seq: 99 }));
    await view.flush();
    const mine = [...view.store.rows.values()].find((stored) => stored.sessionId === "session-a")!;
    const text = mine.body.kind === "plain" ? mine.body.text : "";
    expect(text).toContain(REVISION_2);
    expect(view.cache.peek({ sessionId: "session-a" })?.revision).toBe(REVISION_2);
  });
});

describe("attachments are references, never a second copy of a picture", () => {
  it("replaces an oversized picture with a bounded reference and a marker", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 20_000)] }));
    await view.flush();
    const record = peek(view)!;
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments[0]).toMatchObject({ entryId: "e1", mimeType: "image/png", bytes: 20_000 });
    const part = JSON.parse(record.entries[0]!.json).message.content[0];
    expect(part.data).toBe("");
    expect(part[MESSAGE_METADATA_NS]).toEqual({ cached: TAIL_OMITTED_ATTACHMENT, bytes: 20_000 });
    expect(record.bytes).toBeLessThan(2_000);
  });

  it("keeps a small picture inline, because a reference would cost more", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail({ entries: [picture("e1", 100)] }));
    await view.flush();
    const record = peek(view)!;
    expect(record.attachments).toHaveLength(0);
    expect(JSON.parse(record.entries[0]!.json).message.content[0].data).toBe("A".repeat(100));
  });

  it("keeps not even a reference when the policy says none", async () => {
    const view = harness();
    await prepared(view, descriptor(ENV_A, { attachments: "none" }));
    view.cache.release(tail({ entries: [picture("e1", 20_000), picture("e2", 50)] }));
    await view.flush();
    const record = peek(view)!;
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
    const record = peek(view)!;
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
    const first = peek(view);
    expect(first).toBe(peek(view));
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("answers from the warm set the moment preparation resolves", async () => {
    const view = harness({ rows: [row()] });
    expect((await prepared(view)).kind).toBe("open");
    expect(peek(view)).toMatchObject({ sessionId: "session-a", revision: REVISION });
  });

  it("serves nothing while a write is still in flight", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    expect(peek(view)).toBeUndefined();
    expect(view.cache.counters().records).toBe(0);
    await view.flush();
    expect(peek(view)).toBeDefined();
  });

  it("stops offering a record RP-11 has replaced", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    view.cache.supersede("session-a", REVISION_2);
    expect(peek(view)).toBeUndefined();
  });

  it("warms at most the hot ceiling, and validates everything it keeps", async () => {
    const rows = Array.from({ length: TAIL_SCAN_LIMITS.warmRecords + 6 }, (_, index) =>
      row({ sessionId: `session-${index}`, lastUsedAt: new Date(1_699_900_000_000 + index * 1000).toISOString() }));
    const view = harness({ rows });
    expect((await prepared(view)).kind).toBe("open");
    const counters = view.cache.counters();
    // Every row is accounted for; only the newest few keep their objects.
    expect(counters.records).toBe(rows.length);
    expect(counters.hotRecords).toBe(TAIL_SCAN_LIMITS.warmRecords);
    expect(counters.bytes).toBe(rows.reduce((sum, stored) => sum + stored.bytes, 0));
  });
});

describe("a hostile or enormous database fails closed", () => {
  const manyRows = (count: number) =>
    Array.from({ length: count }, (_, index) => row({ sessionId: `session-${index}` }));

  it("refuses when a pass would examine more rows than the ceiling allows", async () => {
    const view = harness({ rows: manyRows(TAIL_SCAN_LIMITS.scanRows + 1) });
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "purge", stoppedBy: "over-rows" });
    expect(peek(view, "session-1")).toBeUndefined();
    expect(view.store.rows.size).toBe(TAIL_SCAN_LIMITS.scanRows + 1);
  });

  it("refuses when a pass would read more bytes than the ceiling allows", async () => {
    const heavy = Array.from({ length: 60 }, (_, index) =>
      row({ sessionId: `session-${index}`, body: { kind: "plain", text: "x".repeat(1024 * 1024) } }));
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
    expect(await prepared(view)).toMatchObject({ kind: "refused", reason: "purge" });
    expect(peek(view)).toBeUndefined();
  });

  it("removes a row whose own fields are junk, by the key the store hands over", async () => {
    const view = harness({ rows: [row()], faults: { malformedKeys: 2 } });
    expect((await prepared(view)).kind).toBe("open");
    expect(view.cache.counters().discarded.invalid).toBe(2);
    // Counted is not enough: the junk is gone, and only the good row is held.
    expectHolds(view, ["session-a"]);
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
    expect(view.store.transactions.remove).toBeGreaterThanOrEqual(Math.ceil(299 / TAIL_SCAN_LIMITS.batchRows));
  });
});

describe("counters", () => {
  it("report exactly what is held, and reuse their snapshot", async () => {
    const view = harness();
    await prepared(view);
    view.cache.release(tail());
    await view.flush();
    const counters = view.cache.counters();
    expect(counters).toMatchObject({ status: "open", records: 1, durable: true, hotRecords: 1 });
    expect(counters.bytes).toBeGreaterThan(0);
    expect(counters.encryption).toEqual({ kind: "not-applicable" });
    expect(view.cache.counters()).toBe(counters);
    expect(counters.queued).toEqual({ writes: 0, touches: 0, control: 0 });
  });
});
