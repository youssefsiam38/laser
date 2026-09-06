/**
 * The file layer against a real temp root: discovery, retirement, the control
 * inbox and the two-move steer. These are the bits that touch the filesystem
 * in the exact shape the pi-subagents runner reads, so a fixture is the only
 * honest proof — a mock of `fs` would only assert that we called ourselves.
 */
import { PRODUCT_NAME, WIRE_NAMESPACE } from "@lasercode/protocol";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Panel } from "@lasercode/protocol";
import {
  ControlError,
  requestInterrupt,
  requestSteer,
  requestStop,
  steerFileName,
  steerRequestsDir,
  stopRequestsDir,
} from "../../src/subagents/control.js";
import { SubagentsLayer, type SessionRef } from "../../src/subagents/layer.js";

let root: string;
let sessionsDir: string;

const SESSION: SessionRef = { path: "", cwd: "/project", modifiedAt: "2026-09-05T00:00:00.000Z" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-subagents-`));
  sessionsDir = join(root, "sessions", "--project--");
  mkdirSync(sessionsDir, { recursive: true });
  SESSION.path = join(sessionsDir, "a.jsonl");
  writeFileSync(SESSION.path, "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRun(runId: string, status: Record<string, unknown>): string {
  const dir = join(root, "temp", "async-subagent-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ runId, sessionId: SESSION.path, cwd: "/project", ...status }));
  return dir;
}

interface Recorder {
  upserts: Array<{ path: string; panel: Panel }>;
  closes: Array<{ path: string; id: string; reason?: string }>;
}

function makeLayer(now = () => Date.now(), extra: Partial<ConstructorParameters<typeof SubagentsLayer>[0]> = {}) {
  const seen: Recorder = { upserts: [], closes: [] };
  const layer = new SubagentsLayer({
    sink: {
      upsert: (_cwd, path, panel) => seen.upserts.push({ path, panel }),
      close: (path, id, reason) => seen.closes.push({ path, id, ...(reason !== undefined ? { reason } : {}) }),
    },
    sessions: () => [SESSION],
    roots: [join(root, "temp")],
    agentDir: join(root, "agent"),
    now,
    ...extra,
  });
  return { layer, seen };
}

describe("discovering background runs", () => {
  it("turns a live run into a run panel for its session", () => {
    writeRun("r1", { mode: "single", state: "running", startedAt: Date.now(), pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    expect(seen.upserts).toHaveLength(1);
    expect(seen.upserts[0]?.path).toBe(SESSION.path);
    expect(seen.upserts[0]?.panel.id).toBe("subagents:run:r1");
  });

  it("ignores a run whose session the host does not know", () => {
    const dir = join(root, "temp", "async-subagent-runs", "r2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({ runId: "r2", sessionId: "/elsewhere/x.jsonl", mode: "single", state: "running", steps: [] }));
    const { layer, seen } = makeLayer();
    layer.refresh();
    expect(seen.upserts).toHaveLength(0);
  });

  it("does not re-emit an unchanged run, so the wire carries changes only (R9)", () => {
    writeRun("r1", { mode: "single", state: "running", startedAt: Date.now(), pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    layer.refresh();
    layer.refresh();
    expect(seen.upserts).toHaveLength(1);
  });

  it("removes its panels without deleting run files when the feature is disabled", () => {
    const runDir = writeRun("r1", { mode: "single", state: "running", startedAt: Date.now(), pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    let enabled = true;
    const { layer, seen } = makeLayer(() => Date.now(), { enabled: () => enabled });
    layer.refresh();
    enabled = false;
    layer.refresh();

    expect(seen.closes).toContainEqual({ path: SESSION.path, id: "subagents:run:r1", reason: "Subagents is disabled for this project" });
    expect(readFileSync(join(runDir, "status.json"), "utf8")).toContain('"runId":"r1"');
  });

  it("converges a workflow lane and its detailed child status on one panel id", () => {
    writeRun("workflow-1", {
      mode: "workflow",
      state: "running",
      startedAt: Date.now(),
      steps: [{ agent: "researcher", status: "running", workflowKey: "company", runId: "child-1" }],
      preflight: { lanes: [{ key: "company" }] },
    });
    writeRun("child-1", {
      mode: "single",
      state: "running",
      startedAt: Date.now(),
      parentWorkflowRunId: "workflow-1",
      workflowKey: "company",
      steps: [{ agent: "researcher", status: "running", tokens: { input: 120, output: 30 } }],
    });
    const { layer, seen } = makeLayer();
    layer.refresh();
    const children = seen.upserts.filter(({ panel }) => panel.kind === "run");

    expect(new Set(children.map(({ panel }) => panel.id))).toEqual(new Set(["subagents:run:child-1"]));
    expect(children.length).toBeGreaterThanOrEqual(1);
    expect(children.length).toBeLessThanOrEqual(2);
    expect(children.every(({ panel }) => panel.kind === "run" && panel.title === "company")).toBe(true);
    expect(children.every(({ panel }) => panel.kind === "run" && panel.parent?.id === "subagents:plan:workflow-1")).toBe(true);
    expect(children.at(-1)?.panel.kind === "run" && children.at(-1)?.panel.usage).toMatchObject({ input: 120, output: 30 });
  });

  it("treats an unreadable status file as unknown, never as finished", () => {
    const dir = join(root, "temp", "async-subagent-runs", "r3");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), "{ this is not json");
    const { layer, seen } = makeLayer();
    layer.refresh();
    expect(seen.upserts).toHaveLength(0);
    expect(seen.closes).toHaveLength(0);
  });

  it("says why a run left when its directory is reaped (R7)", () => {
    const dir = writeRun("r1", { mode: "single", state: "running", startedAt: Date.now(), pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    rmSync(dir, { recursive: true, force: true });
    layer.refresh();
    expect(seen.closes).toEqual([{ path: SESSION.path, id: "subagents:run:r1", reason: "pruned by pi-subagents retention" }]);
  });

  it("ages a finished run out on the clock, since its file never changes again", () => {
    let clock = 10_000_000;
    writeRun("r1", { mode: "single", state: "complete", startedAt: clock - 1000, endedAt: clock, steps: [{ agent: "worker", status: "complete" }] });
    const { layer, seen } = makeLayer(() => clock);
    layer.refresh();
    expect(seen.upserts).toHaveLength(1);
    clock += 61 * 60_000;
    layer.refresh();
    expect(seen.closes[0]?.reason).toBe("it finished a while ago");
  });
});

describe("foreground children (no status file, no index)", () => {
  function writeTranscript(name: string, at = Date.now()): string {
    const dir = join(sessionsDir, "subagent-artifacts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify({ version: 1, recordType: "message", runId: "fg1", agent: "worker", ts: at })}\n`);
    return file;
  }

  it("finds a live child from its transcript alone and offers nothing to press", () => {
    writeTranscript("fg1_worker_0_transcript.jsonl");
    const { layer, seen } = makeLayer();
    layer.refresh();
    const panel = seen.upserts.at(-1)?.panel;
    expect(panel?.id).toBe("subagents:fg:fg1:0");
    expect(panel?.kind === "run" && panel.lifecycle).toBe("running");
    expect(panel?.kind === "run" && panel.actions).toBeUndefined();
    expect(panel?.kind === "run" && panel.usage?.unavailableReason).toMatch(/until it finishes/);
  });

  it("reads the usage and the outcome once `_meta.json` lands beside it", () => {
    const file = writeTranscript("fg1_worker_0_transcript.jsonl");
    writeFileSync(file.replace("_transcript.jsonl", "_meta.json"), JSON.stringify({
      exitCode: 0,
      model: "gpt-5",
      usage: { input: 10, output: 2, cacheRead: 900, cost: 0.01 },
      timestamp: Date.now(),
    }));
    const { layer, seen } = makeLayer();
    layer.refresh();
    const panel = seen.upserts.at(-1)?.panel;
    expect(panel?.kind === "run" && panel.lifecycle).toBe("done");
    expect(panel?.kind === "run" && panel.usage).toMatchObject({ input: 10, cacheRead: 900, costUsd: 0.01 });
  });
});

describe("the control inbox", () => {
  it("writes a steer the runner's sorter can read", () => {
    const dir = writeRun("r1", { mode: "single", state: "running", steps: [{ agent: "worker", status: "running" }] });
    const path = requestSteer({ asyncDir: dir, message: "  focus on the parser  ", now: () => 1_700_000_000_000, newId: () => "abc" });
    expect(path).toBe(join(steerRequestsDir(dir), steerFileName("abc", 1_700_000_000_000)));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      type: "steer",
      id: "abc",
      ts: 1_700_000_000_000,
      message: "focus on the parser",
      source: WIRE_NAMESPACE,
    });
  });

  it("refuses rather than writing into a closed inbox", () => {
    const dir = writeRun("r1", { mode: "single", state: "running", steps: [] });
    mkdirSync(join(dir, "control"), { recursive: true });
    writeFileSync(join(dir, "control", "steer-inbox-closed.json"), JSON.stringify({ version: 1, closedAt: 1, state: "complete" }));
    expect(() => requestSteer({ asyncDir: dir, message: "hello" })).toThrow(ControlError);
    expect(readdirSync(join(dir, "control"))).toEqual(["steer-inbox-closed.json"]);
  });

  it("carries the child index and id on a stop, so one lane can be stopped", () => {
    const dir = writeRun("r1", { mode: "workflow", state: "running", steps: [] });
    const path = requestStop({ asyncDir: dir, targetIndex: 2, childId: "health", now: () => 5 });
    expect(path.startsWith(stopRequestsDir(dir))).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ type: "stop", targetIndex: 2, childId: "health" });
  });

  it("writes the interrupt where the runner watches for it", () => {
    const dir = writeRun("r1", { mode: "single", state: "running", steps: [] });
    const path = requestInterrupt({ asyncDir: dir });
    expect(path).toBe(join(dir, "control", "interrupt.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).type).toBe("interrupt");
  });
});

describe("actions", () => {
  it("opens a question instead of sending an empty steer", async () => {
    writeRun("r1", { mode: "single", state: "running", pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    const result = await layer.act({ path: SESSION.path, id: "subagents:run:r1", actionId: "steer" });
    expect(result.delivered).toBe(true);
    const decision = seen.upserts.at(-1)?.panel;
    expect(decision?.kind).toBe("decision");
    expect(decision?.id).toBe("subagents:steer:subagents:run:r1");
    expect(decision?.kind === "decision" && decision.fields[0]?.id).toBe("message");
  });

  it("writes the answer to that question into the inbox and takes the question away", async () => {
    const dir = writeRun("r1", { mode: "single", state: "running", pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    const answered = await layer.act({
      path: SESSION.path,
      id: "subagents:steer:subagents:run:r1",
      actionId: "answer",
      value: JSON.stringify({ message: "stop reading and write the patch" }),
    });
    expect(answered.delivered).toBe(true);
    const written = readdirSync(steerRequestsDir(dir));
    expect(written).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(steerRequestsDir(dir), written[0]!), "utf8")).message).toBe("stop reading and write the patch");
    expect(seen.closes.at(-1)).toMatchObject({ id: "subagents:steer:subagents:run:r1", reason: "sent" });
  });

  it("stops one lane of a workflow by its index", async () => {
    const dir = writeRun("r1", {
      mode: "workflow",
      state: "running",
      pid: process.pid,
      steps: [
        { agent: "reviewer", workflowKey: "a", childId: "a", status: "running" },
        { agent: "reviewer", workflowKey: "b", childId: "b", status: "running" },
      ],
    });
    const { layer } = makeLayer();
    layer.refresh();
    await layer.act({ path: SESSION.path, id: "subagents:child:r1:b", actionId: "stop" });
    const files = readdirSync(stopRequestsDir(dir));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(stopRequestsDir(dir), files[0]!), "utf8"))).toMatchObject({ targetIndex: 1, childId: "b" });
  });

  it("hands resume to the session's worker, because files cannot resume a run", async () => {
    writeRun("r1", { mode: "single", state: "paused", pid: process.pid, steps: [{ agent: "worker", status: "paused" }] });
    const forwarded: unknown[] = [];
    const { layer, seen } = makeLayer(Date.now, {
      forward: async (path, command) => {
        forwarded.push({ path, command });
        return true;
      },
    });
    // Resume appears only once a live module has said the bus is reachable.
    layer.observeExtensionMessage(SESSION.path, {
      type: "lasercode/subagents/event",
      event: { type: "bus", reachable: true, methods: ["ping", "status", "steer", "stop", "resume"] },
    });
    layer.refresh();
    const run = seen.upserts.at(-1)?.panel;
    expect(run?.kind === "run" && run.actions?.map((a) => a.id)).toEqual(["resume"]);

    // Pressing it asks what to resume with, because pi-subagents refuses an
    // empty resume and the child has no idea why it woke up.
    expect(await layer.act({ path: SESSION.path, id: "subagents:run:r1", actionId: "resume" })).toEqual({ delivered: true });
    expect(seen.upserts.at(-1)?.panel.id).toBe("subagents:resume:subagents:run:r1");
    expect(forwarded).toEqual([]);

    const answered = await layer.act({
      path: SESSION.path,
      id: "subagents:resume:subagents:run:r1",
      actionId: "answer",
      value: JSON.stringify({ message: "carry on with the migration" }),
    });
    expect(answered.delivered).toBe(true);
    expect(forwarded).toEqual([
      { path: SESSION.path, command: { id: "subagents:run:r1", actionId: "resume", value: "carry on with the migration" } },
    ]);
  });

  it("refuses an empty steer with a sentence rather than writing nothing", async () => {
    writeRun("r1", { mode: "single", state: "running", pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer } = makeLayer();
    layer.refresh();
    await expect(
      layer.act({ path: SESSION.path, id: "subagents:steer:subagents:run:r1", actionId: "answer", value: "{}" }),
    ).rejects.toThrow(/something to say/);
  });

  it("answers false for a panel it does not own", async () => {
    const { layer } = makeLayer();
    expect(await layer.act({ path: SESSION.path, id: "web-access:search:1", actionId: "open" })).toEqual({ delivered: false });
    expect(layer.handles("subagents:run:x")).toBe(true);
    expect(layer.handles("ui:widget:x")).toBe(false);
  });
});

describe("one child, one panel, whichever path saw it", () => {
  it("re-sends its own richer panel when the in-process module declares the same id", () => {
    writeRun("r1", { mode: "single", state: "running", pid: process.pid, steps: [{ agent: "worker", status: "running" }] });
    const { layer, seen } = makeLayer();
    layer.refresh();
    expect(seen.upserts).toHaveLength(1);
    layer.observeDeclaredPanel(SESSION.path, "subagents:run:r1");
    expect(seen.upserts).toHaveLength(2);
    expect(seen.upserts[1]?.panel.id).toBe("subagents:run:r1");
    expect(layer.declared.has("subagents:run:r1")).toBe(true);
  });

  it("leaves alone an id it does not own", () => {
    const { layer, seen } = makeLayer();
    layer.observeDeclaredPanel(SESSION.path, "subagents:external:other");
    expect(seen.upserts).toHaveLength(0);
  });
});
