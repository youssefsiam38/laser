/**
 * M2-T2: the attention state machine and the part of it that has to survive a
 * reload. Pure logic with a temp file for the seen-map, no worker involved.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionAttention } from "@lasercode/protocol";
import { AttentionTracker, type AttentionSnapshot } from "../src/attention.js";

let dir: string;
let clock: number;
const PATH = "/sessions/a.jsonl";
const CWD = "/projects/app";

const iso = (ms: number) => new Date(ms).toISOString();

function tracker(changes: AttentionSnapshot[] = [], storePath?: string): AttentionTracker {
  return new AttentionTracker({
    ...(storePath ? { storePath } : {}),
    onChange: (snapshot) => changes.push(snapshot),
    now: () => new Date(clock),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-attention-`));
  clock = Date.parse("2026-09-05T10:00:00.000Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("AttentionTracker", () => {
  it("acknowledges viewing even when an unanswered dialog keeps attention unchanged", () => {
    const seen: string[] = [];
    const a = new AttentionTracker({ onSeen: path => seen.push(path) });
    a.observeUpdate(PATH, CWD, "agent_start", 1);
    a.dialogRaised(PATH, CWD, "approval");
    a.markSeen(PATH, CWD, 1);
    expect(seen).toEqual([PATH]);
    expect(a.attentionOf(PATH)).toBe("waiting_for_input");
    a.dialogAnswered("approval");
    expect(a.attentionOf(PATH)).toBe("working");
    a.close();
  });
  it("ranks a pending dialog above a running agent, and clears on the answer", () => {
    const changes: AttentionSnapshot[] = [];
    const a = tracker(changes);

    a.observeUpdate(PATH, CWD, "agent_start", 1);
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("working");

    a.dialogRaised(PATH, CWD, "dlg-1");
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("waiting_for_input");

    // Answering is what clears it; the worker sends nothing when a client answers.
    a.dialogAnswered("dlg-1");
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("working");

    a.observeUpdate(PATH, CWD, "agent_end", 2);
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("idle"); // never seen ⇒ not "unread"
    expect(changes.map((c) => c.attention)).toEqual(["working", "waiting_for_input", "working", "idle"]);
  });

  it("marks a finished session unread only once a client has seen it before", () => {
    const a = tracker();
    a.observeUpdate(PATH, CWD, "agent_start", 1);
    clock += 1000;
    a.markSeen(PATH, CWD, 1);
    clock += 1000;
    a.observeUpdate(PATH, CWD, "agent_end", 2);
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("finished_unread");

    clock += 1000;
    a.markSeen(PATH, CWD, 2);
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("idle");
  });

  it("never marks a session nobody has prompted as unread (M13-T47)", () => {
    // An empty chat's row changes only because it was created. Stamping it
    // finished_unread made the launcher refuse to reuse it and start another
    // on every press of +. A session with a message keeps the ordinary rule.
    const a = tracker();
    a.observeUpdate(PATH, CWD, "agent_start", 1);
    clock += 1000;
    a.markSeen(PATH, CWD, 1);
    clock += 1000;
    // Finished, and changed after it was last seen: the ordinary unread shape.
    a.observeUpdate(PATH, CWD, "agent_end", 2);
    const later = iso(clock);
    const row = { path: PATH, id: "a", cwd: CWD, createdAt: later, modifiedAt: later };
    const [empty] = a.decorate([{ ...row, messageCount: 0 }]);
    const [written] = a.decorate([{ ...row, messageCount: 1, firstMessage: "hi" }]);
    expect(empty?.attention).toBe<SessionAttention>("idle");
    expect(written?.attention).toBe<SessionAttention>("finished_unread");
  });

  it("uses the session file's mtime, so a session driven from a terminal turns up unread", () => {
    const a = tracker();
    a.markSeen(PATH, CWD);
    const before = iso(clock - 60_000);
    const after = iso(clock + 60_000);
    expect(a.attentionOf(PATH, before)).toBe<SessionAttention>("idle");
    expect(a.attentionOf(PATH, after)).toBe<SessionAttention>("finished_unread");
    // A session nobody here ever opened falls back to when laser first ran:
    // history stays idle, but something a terminal Pi has just written since
    // reaches the inbox without anyone having to open it here first.
    expect(a.attentionOf("/sessions/never-opened.jsonl", before)).toBe<SessionAttention>("idle");
    expect(a.attentionOf("/sessions/never-opened.jsonl", after)).toBe<SessionAttention>("finished_unread");
  });

  it("puts every session of a crashed worker into error, and clears them when it comes back", () => {
    const a = tracker();
    a.observeUpdate(PATH, CWD, "agent_start", 1);
    a.observeUpdate("/sessions/b.jsonl", CWD, "state", 1);
    a.observeUpdate("/sessions/other.jsonl", "/projects/other", "state", 1);

    a.workerCrashed(CWD, "exit 1");
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("error");
    expect(a.attentionOf("/sessions/b.jsonl")).toBe<SessionAttention>("error");
    expect(a.attentionOf("/sessions/other.jsonl")).toBe<SessionAttention>("idle");

    a.workerRecovered(CWD);
    expect(a.attentionOf(PATH)).toBe<SessionAttention>("idle");
  });

  it("persists seen across a restart, so finished_unread does not resurrect", () => {
    const store = join(dir, "attention.json");
    const first = tracker([], store);
    first.markSeen(PATH, CWD, 7);
    first.close();

    const second = tracker([], store);
    expect(second.seenAt(PATH)).toBe(iso(clock));
    expect(second.attentionOf(PATH, iso(clock - 1000))).toBe<SessionAttention>("idle");
    expect(second.attentionOf(PATH, iso(clock + 1000))).toBe<SessionAttention>("finished_unread");
    second.close();
  });

  it("decorates catalog rows without inventing fields", () => {
    const a = tracker();
    a.markSeen(PATH, CWD);
    const rows = a.decorate([
      { path: PATH, id: "a", cwd: CWD, createdAt: iso(clock), modifiedAt: iso(clock + 5), messageCount: 2 },
      { path: "/sessions/z.jsonl", id: "z", cwd: CWD, createdAt: iso(clock), modifiedAt: iso(clock), messageCount: 0 },
    ]);
    expect(rows[0]).toMatchObject({ attention: "finished_unread", seenAt: iso(clock) });
    expect(rows[1]).toMatchObject({ attention: "idle" });
    expect(rows[1]).not.toHaveProperty("seenAt");
  });
});
