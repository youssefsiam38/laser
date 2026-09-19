import { ErrorCodes, PRODUCT_NAME, TelemetryFold, sessionTelemetryOf } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { SessionTelemetryReader } from "../src/session-telemetry.js";

const ENVIRONMENT = "11111111-2222-3333-4444-555555555555";
const CWD = "/project";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-telemetry-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const header = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD });
const user = (id: string, parentId: string | null, n: number) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`, message: { role: "user", content: `turn ${n}` } });
const assistant = (id: string, parentId: string, n: number) =>
  JSON.stringify({
    type: "message",
    id,
    parentId,
    timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.500Z`,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude",
      content: [{ type: "text", text: "ok" }, { type: "toolCall", name: n % 2 === 0 ? "bash" : "read" }],
      usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } },
    },
  });

function longSession(dir: string, turns: number): string {
  const lines = [header];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const u = `u${i}`;
    const a = `a${i}`;
    lines.push(user(u, parent, i), assistant(a, u, i));
    parent = a;
  }
  const path = join(dir, "session.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function entriesOf(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)
    .filter((row) => (row as { type?: string }).type !== "session");
}

describe("durable telemetry", () => {
  it("computes over a session longer than any client page, identically to the live fold", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = longSession(dir, 30);
      let folded = 0;
      const index = new SessionIndexCache({ onTelemetryPush: () => { folded += 1; } });
      const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
      const reader = new SessionTelemetryReader({ index, revisions });
      const durable = await reader.read(path, { path });
      expect(durable.kind).toBe("answer");
      if (durable.kind !== "answer") return;
      expect(durable.result.history?.records).toBe(60);
      expect(durable.result.history?.prompts).toBe(30);
      expect(durable.result.work?.turns).toBe(30);
      expect(durable.result.spend?.api?.totals.turns).toBe(30);
      expect(durable.result.authority).toBe("durable");
      expect(folded).toBe(60);

      const liveFold = TelemetryFold.create();
      liveFold.ingest(entriesOf(path));
      const live = sessionTelemetryOf(liveFold.state, {
        revision: durable.result.revision,
        environmentKey: durable.result.environmentKey,
        authority: "live",
      });
      const { authority: _da, ...durableBody } = durable.result;
      const { authority: _la, ...liveBody } = live;
      expect(liveBody).toEqual(durableBody);
    } finally {
      cleanup();
    }
  });

  it("answers a known revision from memory and folds only appended records", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = longSession(dir, 12);
      let folded = 0;
      const index = new SessionIndexCache({ onTelemetryPush: () => { folded += 1; } });
      const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
      const reader = new SessionTelemetryReader({ index, revisions });
      const first = await reader.read(path, { path });
      expect(first.kind).toBe("answer");
      if (first.kind !== "answer") return;
      const afterFirst = folded;
      expect(afterFirst).toBe(24);

      const again = await reader.read(path, { path, revision: first.result.revision, environmentKey: first.result.environmentKey });
      expect(again.kind).toBe("answer");
      expect(folded).toBe(afterFirst);
      if (again.kind !== "answer") return;
      expect(again.result).toEqual(first.result);

      appendFileSync(path, `${user("u12", "a11", 12)}\n${assistant("a12", "u12", 12)}\n`);
      const grown = await reader.read(path, { path });
      expect(grown.kind).toBe("answer");
      expect(folded).toBe(afterFirst + 2);
      if (grown.kind !== "answer") return;
      expect(grown.result.history?.records).toBe(26);
      expect(grown.result.revision).not.toBe(first.result.revision);
    } finally {
      cleanup();
    }
  });

  it("refuses a stale revision and a foreign environment key", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = longSession(dir, 2);
      const index = new SessionIndexCache();
      const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
      const reader = new SessionTelemetryReader({ index, revisions });
      const current = await reader.read(path, { path });
      expect(current.kind).toBe("answer");
      if (current.kind !== "answer") return;

      const stale = await reader.read(path, { path, revision: "r1.AAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBB" });
      expect(stale.kind).toBe("refuse");
      if (stale.kind !== "refuse") return;
      expect(stale.error.code).toBe(ErrorCodes.RevisionUnavailable);

      const foreign = await reader.read(path, { path, environmentKey: "e1.AAAAAAAAAAAAAAAAAAAAAA" });
      expect(foreign.kind).toBe("refuse");
      if (foreign.kind !== "refuse") return;
      expect(foreign.error.code).toBe(ErrorCodes.InvalidParams);
    } finally {
      cleanup();
    }
  });

  it("omits a section the caller did not ask for", async () => {
    const { dir, cleanup } = workspace();
    try {
      const path = longSession(dir, 3);
      const index = new SessionIndexCache();
      const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
      const reader = new SessionTelemetryReader({ index, revisions });
      const answer = await reader.read(path, { path, include: ["history"] });
      expect(answer.kind).toBe("answer");
      if (answer.kind !== "answer") return;
      expect(answer.result.history?.records).toBe(6);
      expect(answer.result.spend).toBeUndefined();
      expect(answer.result.work).toBeUndefined();
      expect(answer.result.model).toBeUndefined();
      expect("files" in answer.result).toBe(false);
    } finally {
      cleanup();
    }
  });
});
