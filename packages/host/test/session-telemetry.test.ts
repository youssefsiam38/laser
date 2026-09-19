import { ErrorCodes, PRODUCT_NAME, TelemetryFold, sessionTelemetryOf, type AgentRun, type SessionTelemetry } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRegistry } from "../src/agents/runs.js";
import { SessionIndexCache } from "../src/session-index.js";
import { SessionRevisions } from "../src/session-revision.js";
import { SessionTelemetryReader } from "../src/session-telemetry.js";
import { childSources, computeLiveTelemetry } from "../../worker/src/telemetry.js";

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

function stripLiveOnly(snapshot: SessionTelemetry) {
  const { authority: _a, context: _c, spend, ...rest } = snapshot;
  if (!spend) return rest;
  const { account: _account, ...spendRest } = spend;
  return { ...rest, spend: spendRest };
}

function childFile(dir: string, name: string, cost: number): string {
  const path = join(dir, name);
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: CWD }),
    JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "child" } }),
    JSON.stringify({
      type: "message",
      id: "a",
      parentId: "u",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        usage: { input: 8, output: 2, totalTokens: 10, cost: { total: cost } },
      },
    }),
  ].join("\n") + "\n");
  return path;
}

function runAt(sessionPath: string, root: string, runId: string): AgentRun {
  return {
    agentName: "worker",
    subagentName: runId,
    sessionId: runId,
    runId,
    sessionPath,
    projectCwd: CWD,
    rootSessionPath: root,
    depth: 1,
    parent: { sessionPath: root, sessionId: "session-1" },
    worktree: null,
    origin: "agent",
    status: "completed",
    task: "child",
    model: { provider: "anthropic", id: "claude" },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("live and durable authorities", () => {
  it("agree on a compacted parent with two child runs", async () => {
    const { dir, cleanup } = workspace();
    const registry = new AgentRunRegistry({ now: () => new Date("2026-01-02T00:00:00.000Z") });
    try {
      const parent = join(dir, "parent.jsonl");
      writeFileSync(parent, [
        header,
        user("u1", null, 1),
        assistant("a1", "u1", 1),
        JSON.stringify({
          type: "compaction",
          id: "c1",
          parentId: "a1",
          timestamp: "2026-01-01T00:01:00.000Z",
          summary: "so far",
          usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
        }),
      ].join("\n") + "\n");
      const childA = childFile(dir, "child-a.jsonl", 0.2);
      const childB = childFile(dir, "child-b.jsonl", 0.3);
      registry.upsert(runAt(childA, parent, "run-a"));
      registry.upsert(runAt(childB, parent, "run-b"));

      const index = new SessionIndexCache();
      const revisions = new SessionRevisions({ index, environmentId: ENVIRONMENT });
      const reader = new SessionTelemetryReader({ index, revisions, runs: registry });
      const durable = await reader.read(parent, { path: parent });
      expect(durable.kind).toBe("answer");
      if (durable.kind !== "answer") return;

      const fold = TelemetryFold.create();
      const live = computeLiveTelemetry(fold, entriesOf(parent), "c1", {
        revision: durable.result.revision,
        environmentKey: durable.result.environmentKey,
      }, {
        overlay: {},
        children: childSources(parent, registry.list(parent), (path) => entriesOf(path)),
      });
      expect(stripLiveOnly(live)).toEqual(stripLiveOnly(durable.result));
      expect(durable.result.history?.compactions).toBe(1);
      expect(durable.result.spend?.api?.totals.cost).toBeCloseTo(0.01 + 0.001 + 0.2 + 0.3);
    } finally {
      registry.close();
      cleanup();
    }
  });
});
