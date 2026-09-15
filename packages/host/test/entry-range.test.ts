/**
 * RP-5b acceptance A7, A8 and the durable half of A9: reading one body of one
 * stored entry, worker-free.
 *
 * Every refusal here is a refusal *before* anything is read: a foreign
 * environment, a revision this host is not serving, an entry that is not in
 * this conversation, a range that addresses nothing. What a caller does get is
 * exact: totals, digests, character-aligned slices, and no word about how the
 * conversation is stored.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCodes, PRODUCT_NAME, utf8ByteLength, type ClientRequests } from "@lasercode/protocol";
import { DEFAULT_SESSION_INDEX_LIMITS, SessionIndexCache } from "../src/session-index.js";
import { SessionBodyRange, sha256Hex } from "../src/session-body-range.js";
import { SessionRevisions } from "../src/session-revision.js";

const ENVIRONMENT = "11111111-2222-4333-8444-555555555555";
const CWD = "/projects/a";
const HUGE = "µ".repeat(16 * 1024 * 1024); // multi-byte throughout: 32 MiB of UTF-8

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: CWD, timestamp: "2026-01-01T00:00:00.000Z" });
const prompt = { type: "message", id: "e0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "start" }] } };
const reply = { type: "message", id: "e1", parentId: "e0", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: HUGE }, { type: "thinking", thinking: "short" }] } };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-range-`));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, [header, JSON.stringify(prompt), JSON.stringify(reply)].join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function services() {
  const reads: string[] = [];
  // The acceptance body is 32 MiB in one record; the shipped index refuses a
  // line that large by default, so the reader is exercised with limits that
  // admit it. Nothing else about the reader changes.
  const index = new SessionIndexCache({ limits: { ...DEFAULT_SESSION_INDEX_LIMITS, lineBytes: 64 * 1024 * 1024, fileBytes: 256 * 1024 * 1024, indexBytes: 16 * 1024 * 1024 } });
  const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
  const range = new SessionBodyRange({ index, revisions, onRead: (entry) => reads.push(entry.id ?? "") });
  return { index, revisions, range, reads };
}

const params = (over: Partial<ClientRequests["session/entry_range"]["params"]> = {}): ClientRequests["session/entry_range"]["params"] => ({
  path: "/unused", environmentKey: "", revision: "", entryId: "e1", component: { kind: "assistant_text" }, offset: 0, ...over,
});

describe("reading one body from the stored conversation", () => {
  it("answers exact totals, digests and character-aligned slices without a worker", async () => {
    const file = fixture();
    try {
      const { range, revisions, index, reads } = services();
      const indexed = await index.read(file.path);
      expect(indexed.ok).toBe(true);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, limit: 4096 }));
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      expect(answer.result.authority).toBe("durable");
      expect(answer.result.totalBytes).toBe(utf8ByteLength(HUGE));
      expect(answer.result.contentDigest).toBe(sha256Hex(HUGE));
      expect(answer.result.sliceDigest).toBe(sha256Hex(answer.result.text));
      // Never half a character, whatever the byte limit lands on.
      expect(answer.result.bytes % 2).toBe(0);
      expect(answer.result.text.includes("\uFFFD")).toBe(false);
      expect(answer.result.next).toBe(answer.result.bytes);
      expect(reads).toEqual(["e1"]);
      // Nothing in the answer says anything about storage.
      expect(JSON.stringify(answer.result)).not.toContain(file.path);
    } finally { file.cleanup(); }
  });

  it("reconstructs a whole body from ranges, holding one slice at a time", { timeout: 60_000 }, async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      // A test client that never holds more than one slice plus a digest.
      const hash = await import("node:crypto").then(crypto => crypto.createHash("sha256"));
      let offset: number | undefined = 0;
      let held = 0;
      let peak = 0;
      let slices = 0;
      let total = 0;
      while (offset !== undefined) {
        const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, offset, limit: 64 * 1024 }));
        if (answer.kind !== "answer") throw new Error("unexpected refusal");
        held = utf8ByteLength(answer.result.text);
        peak = Math.max(peak, held);
        hash.update(answer.result.text, "utf8");
        total += held;
        slices += 1;
        offset = answer.result.next;
      }
      expect(total).toBe(utf8ByteLength(HUGE));
      expect(hash.digest("hex")).toBe(sha256Hex(HUGE));
      expect(slices).toBeGreaterThan(500);
      // Never more than one payload in hand at any point.
      expect(peak).toBeLessThanOrEqual(64 * 1024);
    } finally { file.cleanup(); }
  });

  it("refuses a foreign environment before reading anything", async () => {
    const file = fixture();
    try {
      const { range, reads } = services();
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: "someone-else", revision: "whatever" }));
      expect(answer.kind).toBe("refuse");
      if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.InvalidParams);
      expect(reads).toEqual([]);
    } finally { file.cleanup(); }
  });

  it("refuses a revision it is not serving rather than answering another state's bytes", async () => {
    const file = fixture();
    try {
      const { range, revisions, reads } = services();
      const answer = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision: "r1.aaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
      expect(answer.kind).toBe("refuse");
      if (answer.kind === "refuse") {
        expect(answer.error.code).toBe(ErrorCodes.RevisionUnavailable);
        expect(answer.error.message).toMatch(/Open it again/);
      }
      expect(reads).toEqual([]);
    } finally { file.cleanup(); }
  });

  it("refuses an unknown entry, an absent component and a hostile range", async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const base = { path: file.path, environmentKey: revisions.environmentKey, revision };
      for (const over of [
        { entryId: "nope" },
        { component: { kind: "tool_result" as const } },
        { offset: 10 ** 9 },
        { offset: 1 }, // inside a two-byte character
      ]) {
        const answer = await range.read(file.path, params({ ...base, ...over }));
        expect(answer.kind).toBe("refuse");
        if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.InvalidParams);
      }
    } finally { file.cleanup(); }
  });

  it("says the conversation is gone rather than inventing an answer", async () => {
    const { range, revisions } = services();
    const answer = await range.read("/nowhere/session.jsonl", params({ path: "/nowhere/session.jsonl", environmentKey: revisions.environmentKey, revision: "r" }));
    expect(answer.kind).toBe("refuse");
    if (answer.kind === "refuse") expect(answer.error.code).toBe(ErrorCodes.SessionNotFound);
  });

  it("leaves an oversized record out of a durable page and lists it exactly", async () => {
    const file = fixture();
    try {
      const { index, revisions } = services();
      const { SessionProjection } = await import("../src/session-projection.js");
      const projection = new SessionProjection({ index, revisions });
      const answer = await projection.read(file.path, { tail: 40 }, undefined, 16 * 1024);
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      expect(answer.result.entries).toHaveLength(1);
      expect((answer.result.entries[0] as { id: string }).id).toBe("e0");
      expect(answer.result.window!.elided).toEqual([{
        id: "e1", parentId: "e0", type: "message", role: "assistant",
        bodies: [
          { component: { kind: "assistant_text" }, totalBytes: utf8ByteLength(HUGE), contentDigest: sha256Hex(HUGE) },
          { component: { kind: "reasoning" }, totalBytes: 5, contentDigest: sha256Hex("short") },
        ],
      }]);
      // The delivered record is still exactly what the file holds.
      expect(answer.result.entries[0]).toEqual(prompt);
    } finally { file.cleanup(); }
  });

  it("serves the same bytes and digest a live authority would", async () => {
    const file = fixture();
    try {
      const { range, revisions, index } = services();
      const indexed = await index.read(file.path);
      const revision = revisions.revisionOf(indexed.ok ? indexed.index : (undefined as never));
      const durable = await range.read(file.path, params({ path: file.path, environmentKey: revisions.environmentKey, revision, component: { kind: "reasoning" } }));
      const { bodyRangeSlice } = await import("@lasercode/protocol");
      const live = bodyRangeSlice(reply, { component: { kind: "reasoning" }, offset: 0 }, revision, "live", sha256Hex);
      expect(durable.kind === "answer" && durable.result.text).toBe("short");
      expect(live.ok && live.result.contentDigest).toBe(durable.kind === "answer" ? durable.result.contentDigest : "");
      expect(live.ok && live.result.authority).toBe("live");
    } finally { file.cleanup(); }
  });
});
