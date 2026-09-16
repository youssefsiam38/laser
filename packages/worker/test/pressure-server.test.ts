/**
 * The worker server's half of RP-8 (milestone C): the directive it answers,
 * the three steps it actually performs, and the counters it reports.
 *
 * A fake driver stands in for the engine, so what is proved here is the
 * worker's own behaviour — which sessions keep their memos, what a replay trim
 * gives back, who is told to keep less, and what is refused.
 */
import { describe, expect, it } from "vitest";
import {
  ErrorCodes,
  LIFETIME_RETRY,
  memoryPressureDirectiveResultSchema,
  memoryPressureReportSchema,
  type JsonRpcMessage,
  type PiExtensionCommand,
  type SessionState,
  type UiDialogRequest,
} from "@lasercode/protocol";
import { WorkerServer } from "../src/server.js";
import type { DriverEvent, DriverListener, SessionDriver } from "../src/driver.js";

class PressureDriver implements SessionDriver {
  readonly kind = "stable-sdk" as const;
  listeners = new Set<DriverListener>();
  commands: PiExtensionCommand[] = [];
  accepts = true;
  pending: UiDialogRequest[] = [];
  private st: SessionState = {
    path: "/tmp/fake/s1.jsonl",
    id: "s1",
    cwd: "/tmp/fake",
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    autoCompactionEnabled: true,
    messageCount: 1,
    pendingMessageCount: 0,
  };
  async open(options: { sessionPath?: string }) {
    if (options.sessionPath) this.st = { ...this.st, path: options.sessionPath, id: options.sessionPath };
    return this.st;
  }
  state() { return this.st; }
  setStreaming(streaming: boolean) { this.st = { ...this.st, isStreaming: streaming }; }
  entries() { return { entries: [], leafId: null }; }
  async prompt() { return { accepted: true, queued: false }; }
  async steer() { return true; }
  async cancel() {}
  subscribe(listener: DriverListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: DriverEvent) { for (const listener of this.listeners) listener(event); }
  respondToUi() {}
  pendingUi() { return this.pending; }
  deliverExtensionCommand(command: PiExtensionCommand) {
    this.commands.push(command);
    return this.accepts;
  }
  sessionHeader() { return { id: this.st.id }; }
  async dispose() {}
}

function harness(options: { workerGeneration?: number } = {}) {
  const out: JsonRpcMessage[] = [];
  const drivers: PressureDriver[] = [];
  const server = new WorkerServer({
    cwd: "/tmp/fake",
    createDriver: () => {
      const driver = new PressureDriver();
      drivers.push(driver);
      return driver;
    },
    send: (message) => out.push(message),
    replayBuffer: 100,
    replayBudgetBytes: 4_096,
    ...(options.workerGeneration !== undefined ? { workerGeneration: options.workerGeneration } : {}),
  });
  const call = async (id: number, method: string, params?: unknown) => {
    await server.handle({ jsonrpc: "2.0", id, method, params });
    return out.find((message) => "id" in message && message.id === id) as { result?: never; error?: { code: number; message: string } };
  };
  const reports = () => out.filter((message) => "method" in message && message.method === "pi/resource/pressure") as Array<{ params: never }>;
  return { server, out, drivers, call, reports };
}

let nextId = 1_000;
const open = async (h: ReturnType<typeof harness>, path: string) => {
  const answer = await h.call((nextId += 1), "session/load", { path });
  expect(answer.error, JSON.stringify(answer.error)).toBeUndefined();
};

describe("the directive the host sends", () => {
  it("runs the pass and answers with its own rows", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    const answer = (await h.call(10, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 3 })) as {
      result: { applied: boolean; ran: string[]; results: unknown[] };
    };
    expect(answer.result.applied).toBe(true);
    expect(answer.result.ran).toEqual(["ephemeral_caches", "replay_suffixes", "task_records"]);
    expect(memoryPressureDirectiveResultSchema.safeParse(answer.result).success).toBe(true);
    // The rows travel in the answer; an unasked notification never repeats them.
    expect(h.reports().every((report) => (report.params as { ran: string[] }).ran.length === 0)).toBe(true);
    await h.server.dispose();
  });

  it("refuses a directive for another generation, and one sent to a worker with none", async () => {
    const h = harness({ workerGeneration: 3 });
    const wrong = (await h.call(1, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 4 })) as {
      result: { applied: boolean; ran: string[] };
    };
    expect(wrong.result).toMatchObject({ applied: false, ran: [], results: [] });

    const blind = harness();
    const refused = (await blind.call(1, "pi/worker/pressure", { level: "critical", epoch: 1, generation: 1 })) as {
      result: { applied: boolean };
    };
    expect(refused.result.applied).toBe(false);
    await h.server.dispose();
    await blind.server.dispose();
  });

  it("refuses a directive once this worker has agreed to retire, before anything runs", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    const retired = (await h.call(20, "pi/worker/retire", { mode: "explicit" })) as { result?: { retiring: boolean } };
    expect(retired.result).toEqual({ retiring: true });
    // Admission never reopens, and it refuses before the handler is reached:
    // a worker that is going does not start releasing things.
    const late = (await h.call(21, "pi/worker/pressure", { level: "critical", epoch: 1, generation: 3 })) as {
      error?: { code: number; data?: { retry?: string } };
    };
    expect(late.error?.code).toBe(ErrorCodes.DriverUnavailable);
    expect(late.error?.data?.retry).toBe(LIFETIME_RETRY);
    for (const driver of h.drivers) expect(driver.commands).toEqual([]);
    await h.server.dispose();
  });

  it("refuses a directive that arrives after this worker was disposed", async () => {
    const h = harness({ workerGeneration: 9 });
    await h.server.dispose();
    const answer = (await h.call(1, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 9 })) as {
      result: { applied: boolean };
    };
    expect(answer.result.applied).toBe(false);
  });

  it("tells each session's companion to keep less, and never waits for it", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    await open(h, "/tmp/fake/b.jsonl");
    await h.call(2, "pi/worker/pressure", { level: "critical", epoch: 1, generation: 3 });
    // Every live session was told, exactly once, and nothing waited for it.
    const told = h.drivers.filter((driver) => driver.commands.length > 0);
    expect(told.length).toBe(2);
    for (const driver of told) {
      expect(driver.commands).toEqual([{ type: "lasercode/task/pressure", level: "critical" }]);
    }
    await h.server.dispose();
  });

  it("does not claim a release for a delivery nobody handled", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    for (const driver of h.drivers) driver.accepts = false;
    const answer = (await h.call(3, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 3 })) as {
      result: { results: Array<{ action: string; outcome: string; released?: unknown }> };
    };
    const row = answer.result.results.find((event) => event.action === "task_records")!;
    expect(row.outcome).toBe("nothing_to_give");
    expect(row.released).toBeUndefined();

    // An accepted delivery is a delivery, not a measured release. A second
    // directive to the same worker would be inside its cooldown, so this is a
    // fresh one — the cooldown itself is proved in `pressure.test.ts`.
    const other = harness({ workerGeneration: 3 });
    await open(other, "/tmp/fake/a.jsonl");
    const again = (await other.call(4, "pi/worker/pressure", { level: "warning", epoch: 2, generation: 3 })) as {
      result: { results: Array<{ action: string; outcome: string; released?: unknown }> };
    };
    const accepted = again.result.results.find((event) => event.action === "task_records")!;
    expect(accepted.outcome).toBe("unavailable");
    expect(accepted.released).toBeUndefined();
    await other.server.dispose();
    await h.server.dispose();
  });

  it("keeps the memos of a session that is holding work", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    h.drivers[0]!.setStreaming(true);
    const answer = (await h.call(5, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 3 })) as {
      result: { results: Array<{ action: string; outcome: string; reason?: string }> };
    };
    const row = answer.result.results.find((event) => event.action === "ephemeral_caches")!;
    // Nothing was released, and the reason is the pin rather than a shrug.
    expect(row).toMatchObject({ outcome: "held", reason: "pins_held" });
    await h.server.dispose();
  });
});

describe("what this worker says it is holding", () => {
  it("answers the retained-store question and its own report from the same expression", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    const stores = (await h.call(6, "pi/worker/retained-stores", {})) as { result: { stores: Record<string, unknown> } };
    const answer = (await h.call(7, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 3 })) as {
      result: { stores: Record<string, unknown> };
    };
    expect(Object.keys(answer.result.stores).sort()).toEqual(Object.keys(stores.result.stores).sort());
    expect(answer.result.stores["workerSessions"]).toEqual(stores.result.stores["workerSessions"]);
    await h.server.dispose();
  });

  it("never lets a path, a pid or a word into a report", async () => {
    const h = harness({ workerGeneration: 3 });
    await open(h, "/tmp/fake/a.jsonl");
    await h.call(8, "pi/worker/pressure", { level: "warning", epoch: 1, generation: 3 });
    for (const report of h.reports()) {
      const text = JSON.stringify(report.params);
      expect(memoryPressureReportSchema.safeParse(report.params).success).toBe(true);
      expect(text).not.toContain("/tmp/fake");
      expect(text).not.toContain(".jsonl");
      expect(text).not.toMatch(/pid/i);
    }
    await h.server.dispose();
  });
});
