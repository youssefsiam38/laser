import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PRODUCT_NAME,
  type AgentRun,
  type ClientRequests,
  type JsonRpcMessage,
  type SessionTelemetry,
} from "@lasercode/protocol";
import { HostServer, defaultWorkerMain } from "../src/index.js";

class Client {
  private socket!: WebSocket;
  private nextId = 1;
  readonly inbound: JsonRpcMessage[] = [];

  async connect(url: string): Promise<void> {
    this.socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    this.socket.on("message", (data) => this.inbound.push(JSON.parse(data.toString()) as JsonRpcMessage));
    await new Promise<void>((resolve) => this.socket.once("open", resolve));
  }

  async request<M extends keyof ClientRequests>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const found = this.inbound.find((candidate) => "id" in candidate && candidate.id === id) as
        | { result?: ClientRequests[M]["result"]; error?: { message: string } }
        | undefined;
      if (found) {
        if (found.error) throw new Error(found.error.message);
        return found.result as ClientRequests[M]["result"];
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${method}`);
  }

  async waitFor(predicate: (message: JsonRpcMessage) => boolean, timeoutMs = 30_000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.inbound.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for host message; received ${JSON.stringify(this.inbound.slice(-5))}`);
  }

  close(): void {
    this.socket.close();
  }
}

const AT = "2099-01-01T00:00:00.000Z";

function session(path: string, cwd: string, id: string, provider: string, model: string, input: number, output: number, cost: number): void {
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id, timestamp: AT, cwd }),
    JSON.stringify({ type: "message", id: `${id}-u`, parentId: null, timestamp: AT, message: { role: "user", content: id } }),
    JSON.stringify({
      type: "message",
      id: `${id}-a`,
      parentId: `${id}-u`,
      timestamp: "2099-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        provider,
        model,
        content: [{ type: "text", text: "done" }],
        usage: { input, output, totalTokens: input + output, cost: { total: cost } },
      },
    }),
  ].join("\n") + "\n");
}

function run(over: {
  runId: string;
  sessionPath: string;
  rootSessionPath: string;
  projectCwd: string;
  parentPath: string;
  parentId: string;
  depth: number;
  provider: string;
  model: string;
}): AgentRun {
  return {
    agentName: "reviewer",
    subagentName: over.runId,
    sessionId: over.runId,
    runId: over.runId,
    sessionPath: over.sessionPath,
    projectCwd: over.projectCwd,
    rootSessionPath: over.rootSessionPath,
    depth: over.depth,
    parent: { sessionPath: over.parentPath, sessionId: over.parentId },
    worktree: null,
    origin: "agent",
    status: "completed",
    task: over.runId,
    model: { provider: over.provider, id: over.model },
    startedAt: AT,
    updatedAt: AT,
    endedAt: AT,
  };
}

let base: string;
let host: HostServer | undefined;
let client: Client | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-telemetry-restart-`));
  for (const directory of ["agent", "project", "sessions", "state"]) {
    mkdirSync(join(base, directory), { recursive: true });
  }
  writeFileSync(join(base, "agent", "models.json"), JSON.stringify({
    providers: {
      anthropic: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "inert",
        models: [{ id: "claude", contextWindow: 8_000, maxTokens: 200 }],
      },
      "openai-codex": {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "inert",
        models: [{ id: "gpt-5", contextWindow: 8_000, maxTokens: 200 }],
      },
      google: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        apiKey: "inert",
        models: [{ id: "gemini", contextWindow: 8_000, maxTokens: 200 }],
      },
    },
  }));
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({
    defaultProvider: "anthropic",
    defaultModel: "claude",
    enabledModels: ["anthropic/claude"],
  }));
});

afterEach(async () => {
  client?.close();
  await host?.close().catch(() => undefined);
  rmSync(base, { recursive: true, force: true });
  client = undefined;
  host = undefined;
});

function expectSpend(
  telemetry: SessionTelemetry,
  authority: "live" | "durable",
  expected = { input: 50, output: 5, total: 55, turns: 2, cost: 5, included: 2, unavailable: 0 },
): void {
  expect(telemetry.authority).toBe(authority);
  expect(telemetry.spend?.billing).toBe("mixed");
  expect(telemetry.spend?.coverage).toEqual({
    knownChildren: 2,
    includedChildren: expected.included,
    unavailableChildren: expected.unavailable,
  });
  expect(telemetry.spend?.api?.totals).toMatchObject({
    input: expected.input,
    output: expected.output,
    total: expected.total,
    turns: expected.turns,
    cost: expected.cost,
  });
}

describe.skipIf(!existsSync(defaultWorkerMain()))("restart-safe production telemetry", () => {
  it("keeps persisted child and grandchild API spend across live open and worker restart", async () => {
    const cwd = join(base, "project");
    const parent = join(base, "sessions", "parent.jsonl");
    const child = join(base, "sessions", "child.jsonl");
    const grandchild = join(base, "sessions", "grandchild.jsonl");
    const unrelatedRoot = join(base, "sessions", "unrelated-root.jsonl");
    const unrelatedChild = join(base, "sessions", "unrelated-child.jsonl");

    session(parent, cwd, "parent", "openai-codex", "gpt-5", 40, 4, 4);
    session(child, cwd, "child", "anthropic", "claude", 20, 2, 2);
    session(grandchild, cwd, "grandchild", "google", "gemini", 30, 3, 3);
    session(unrelatedRoot, cwd, "other", "anthropic", "claude", 1, 1, 1);
    session(unrelatedChild, cwd, "other-child", "anthropic", "claude", 900, 100, 100);

    const runs: AgentRun[] = [
      run({ runId: "child-run", sessionPath: child, rootSessionPath: parent, projectCwd: cwd, parentPath: parent, parentId: "parent", depth: 1, provider: "anthropic", model: "claude" }),
      run({ runId: "child-run-duplicate", sessionPath: child, rootSessionPath: parent, projectCwd: cwd, parentPath: parent, parentId: "parent", depth: 1, provider: "anthropic", model: "claude" }),
      run({ runId: "grandchild-run", sessionPath: grandchild, rootSessionPath: parent, projectCwd: cwd, parentPath: child, parentId: "child", depth: 2, provider: "google", model: "gemini" }),
      run({ runId: "unrelated-run", sessionPath: unrelatedChild, rootSessionPath: unrelatedRoot, projectCwd: cwd, parentPath: unrelatedRoot, parentId: "other", depth: 1, provider: "anthropic", model: "claude" }),
    ];
    writeFileSync(join(base, "state", "agent-runs.json"), JSON.stringify({ version: 1, runs }, null, 2));

    host = new HostServer({
      agentDir: join(base, "agent"),
      sessionDir: join(base, "sessions"),
      stateDir: join(base, "state"),
      workerIdleMs: 600_000,
      workerSweepMs: 0,
      log: () => undefined,
    });
    client = new Client();
    const hostUrl = (await host.listen()).url;
    await client.connect(hostUrl);

    const durable = await client.request("pi/session/telemetry", { path: parent, include: ["spend"] });
    expectSpend(durable, "durable");

    await client.request("session/load", { path: parent });
    const live = await client.request("pi/session/telemetry", { path: parent, include: ["spend"] });
    expectSpend(live, "live");
    const childOnly = await client.request("pi/session/telemetry", { path: child, include: ["spend"] });
    expect(childOnly.spend?.api?.totals).toMatchObject({ input: 50, output: 5, cost: 5, turns: 2 });
    // The child file's own $2 plus its $3 grandchild; never its parent or sibling.
    expect(childOnly.spend?.coverage).toEqual({ knownChildren: 1, includedChildren: 1, unavailableChildren: 0 });

    await client.request("pi/worker/restart", { cwd });
    expect(host.pool.openSessions(cwd)).toContain(parent);
    const restarted = await client.request("pi/session/telemetry", { path: parent, include: ["spend"] });
    expectSpend(restarted, "live");

    const observer = new Client();
    await observer.connect(hostUrl);
    await observer.request("session/load", { path: parent });
    await observer.request("pi/session/telemetry", { path: parent, include: ["spend"] });

    appendFileSync(child, [
      JSON.stringify({ type: "message", id: "child-u2", parentId: "child-a", timestamp: "2099-01-01T00:00:02.000Z", message: { role: "user", content: "again" } }),
      JSON.stringify({
        type: "message",
        id: "child-a2",
        parentId: "child-u2",
        timestamp: "2099-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [{ type: "text", text: "again" }],
          usage: { input: 70, output: 7, totalTokens: 77, cost: { total: 7 } },
        },
      }),
    ].join("\n") + "\n");
    await client.request("session/load", { path: child });
    const appended = await observer.waitFor((message) => {
      if (!("method" in message) || message.method !== "session/update") return false;
      const params = message.params as { sessionPath?: string; telemetry?: SessionTelemetry };
      return params.sessionPath === parent && params.telemetry?.spend?.api?.totals.cost === 12;
    });
    expect((appended as { params: object }).params).not.toHaveProperty("telemetryGeneration");
    expectSpend((appended as { params: { telemetry: SessionTelemetry } }).params.telemetry, "live", {
      input: 120, output: 12, total: 132, turns: 3, cost: 12, included: 2, unavailable: 0,
    });

    rmSync(grandchild);
    await client.request("session/load", { path: child });
    const partial = await observer.waitFor((message) => {
      if (!("method" in message) || message.method !== "session/update") return false;
      const params = message.params as { sessionPath?: string; telemetry?: SessionTelemetry };
      return params.sessionPath === parent && params.telemetry?.spend?.coverage?.unavailableChildren === 1;
    });
    expectSpend((partial as { params: { telemetry: SessionTelemetry } }).params.telemetry, "live", {
      input: 90, output: 9, total: 99, turns: 2, cost: 9, included: 1, unavailable: 1,
    });
    observer.close();
  }, 120_000);
});
