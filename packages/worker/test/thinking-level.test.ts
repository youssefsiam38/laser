import { PRODUCT_NAME, type ClientRequests, type JsonRpcMessage, type SessionState, type SessionUpdateParams } from "@lasercode/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerServer } from "../src/server.js";
import { StableSdkDriver } from "../src/drivers/stable-sdk.js";
import { fallbackDefaultAgent, fallbackPolicy, fallbackSnapshot } from "../src/agents/definitions.js";
import { rootRecord, rootRole } from "../src/agents/session-config.js";
import { startStubProvider, type StubAnswer, type StubProvider } from "./agents/stub-provider.js";

let base: string;
let server: WorkerServer;
let stubs: StubProvider[];
let answers: Array<(index: number) => StubAnswer>;
let replies: JsonRpcMessage[];
let nextId = 0;
let onModelSelect: ((id: string) => Promise<void>) | undefined;
const models = [{ provider: "stub", id: "stub-1" }, { provider: "stub-b", id: "stub-b-1" }];
const definition = { ...fallbackDefaultAgent(), model: models[0]!, thinkingLevel: "medium" as const };
const promptContent = [{ type: "text" as const, text: "Continue." }];

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-thinking-`));
  for (const dir of ["project", "agent", "sessions", "state"]) mkdirSync(join(base, dir));
  onModelSelect = undefined;
  answers = [() => ({ text: "a" }), () => ({ text: "b" })];
  stubs = await Promise.all(models.map((_, i) => startStubProvider((_request, index) => answers[i]!(index))));
  writeFileSync(join(base, "agent", "models.json"), JSON.stringify({ providers: Object.fromEntries(models.map((model, i) => [model.provider, {
    baseUrl: stubs[i]!.url, api: "openai-completions", apiKey: "stub-key",
    models: [{ id: model.id, reasoning: true, contextWindow: 8000, maxTokens: 1000 }],
  }])) }));
  writeFileSync(join(base, "agent", "settings.json"), JSON.stringify({
    defaultProvider: models[0]!.provider, defaultModel: models[0]!.id,
    defaultThinkingLevel: "low", retry: { enabled: false }, fallbackChains: [{ models }],
  }));
  startWorker();
  await syncDefinitions();
});

afterEach(async () => {
  await server?.dispose();
  await Promise.all(stubs.map((stub) => stub.close()));
  rmSync(base, { recursive: true, force: true });
});

function startWorker(): void {
  replies = [];
  server = new WorkerServer({ cwd: join(base, "project"), agentDir: join(base, "agent"),
    sessionDir: join(base, "sessions"), stateDir: join(base, "state"), features: [], projectTrusted: true,
    createDriver: () => new StableSdkDriver([(pi) => {
      pi.on("model_select", async (event) => { await onModelSelect?.(event.model.id); });
    }]),
    send: (message) => replies.push(message),
  });
}
async function call<M extends keyof ClientRequests>(method: M, params: ClientRequests[M]["params"]): Promise<ClientRequests[M]["result"]> {
  const id = ++nextId;
  await server.handle({ jsonrpc: "2.0", id, method, params });
  const reply = replies.find((message) => "id" in message && message.id === id) as { result?: ClientRequests[M]["result"]; error?: unknown };
  expect(reply).toBeDefined();
  expect(reply.error).toBeUndefined();
  return reply.result!;
}
async function syncDefinitions(): Promise<void> {
  const snapshot = fallbackSnapshot();
  await call("agents/sync", { snapshot: { ...snapshot, agents: snapshot.agents.map((agent) => agent.name === definition.name ? definition : agent) } });
}
async function open(child: boolean): Promise<string> {
  if (!child) return (await call("session/new", { cwd: join(base, "project") })).state.path;
  // A saved child is loaded through the same worker route as a child's composer.
  const driver = new StableSdkDriver();
  const parentPath = join(base, "sessions", "parent.jsonl");
  try {
    await driver.open({ cwd: join(base, "project"), agentDir: join(base, "agent"), sessionDir: join(base, "sessions"), features: [], projectTrusted: true,
      agent: { definition, policy: fallbackPolicy(),
        role: { ...rootRole(definition.name), kind: "child", subagentName: "thinker", depth: 1, isolated: false, parent: { sessionPath: parentPath, sessionId: "parent", agentName: definition.name } },
        record: { ...rootRecord(definition.name), kind: "child", subagentName: "thinker", parentPath },
      },
    });
    await driver.prompt(promptContent);
    const path = driver.state().path;
    await driver.dispose();
    await call("session/load", { path });
    return path;
  } finally { await driver.dispose(); }
}
const efforts = (index = 0) => stubs[index]!.requests.map((request) => request.reasoning_effort);
function settlements(path: string): number {
  return replies.filter((message) => {
    if (!("method" in message) || message.method !== "session/update") return false;
    const params = message.params as SessionUpdateParams;
    return params.sessionPath === path && params.update.kind === "agent_settled";
  }).length;
}
async function prompt(path: string): Promise<void> {
  const before = settlements(path);
  await call("session/prompt", { path, content: promptContent });
  // Child prompts return upon admission, not settlement. Await the real event.
  await expect.poll(() => settlements(path)).toBeGreaterThan(before);
}
async function select(path: string, level: "medium" | "high"): Promise<void> {
  expect((await call("pi/thinking/set", { path, level })).state.thinkingLevel).toBe(level);
}
async function reload(path: string): Promise<SessionState> {
  await server.dispose();
  startWorker();
  await syncDefinitions();
  return (await call("session/load", { path })).state;
}

it.each([false, true])("keeps an idle choice through later prompts and a fresh worker load (child=%s)", async (child) => {
  const path = await open(child);
  await prompt(path);
  expect(efforts().at(-1)).toBe("medium");
  await select(path, "high");
  await prompt(path);
  await prompt(path);
  expect(efforts().slice(-2)).toEqual(["high", "high"]);
  expect((await reload(path)).thinkingLevel).toBe("high");
  await prompt(path);
  expect(efforts().at(-1)).toBe("high");
  const entries = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string; thinkingLevel?: string });
  expect(entries.filter((entry) => entry.type === "thinking_level_change").at(-1)?.thinkingLevel).toBe("high");
});

it.each([false, true])("applies a choice during an in-flight request to subsequent turns (child=%s)", async (child) => {
  const path = await open(child);
  answers[0] = () => ({ text: "held", delayMs: 300 });
  const before = efforts().length;
  const inFlight = prompt(path);
  await expect.poll(() => efforts().length).toBe(before + 1);
  expect(efforts().at(-1)).toBe("medium");
  await select(path, "high");
  await inFlight;
  await prompt(path);
  await prompt(path);
  expect(efforts().slice(-2)).toEqual(["high", "high"]);
});

it.each([false, true])("keeps the chosen effort through fallback, reload on the fallback, and return (child=%s)", async (child) => {
  const path = await open(child);
  await prompt(path);
  expect(efforts().at(-1)).toBe("medium");
  await select(path, "high");
  answers[0] = () => ({ status: 429, body: { error: { message: "Rate limit reached. Please try again in 1s." } } });
  await prompt(path);
  expect(efforts().at(-1)).toBe("high");
  expect(efforts(1)).toEqual(["high"]);
  expect(await reload(path)).toMatchObject({ thinkingLevel: "high", model: models[1] });
  await prompt(path);
  expect(efforts(1)).toEqual(["high", "high"]);
  // The real cooldown expires; then B's failure permits a single return to A.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  answers[0] = () => ({ text: "returned" });
  answers[1] = () => ({ status: 500, body: { error: { message: "Internal server error" } } });
  await prompt(path);
  expect(efforts().at(-1)).toBe("high");
  expect((await call("session/load", { path })).state.model?.id).toBe(models[0]!.id);
  await prompt(path);
  expect(efforts().slice(-2)).toEqual(["high", "high"]);
});


it("uses a newer explicit choice made while a fallback model-select hook is awaiting", async () => {
  const path = await open(false);
  await prompt(path);
  await select(path, "high");
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  onModelSelect = async (id) => {
    if (id !== models[1]!.id) return;
    entered = true;
    await gate;
  };
  answers[0] = () => ({ status: 500, body: { error: { message: "Internal server error" } } });
  const switching = prompt(path);
  try {
    await expect.poll(() => entered).toBe(true);
    await select(path, "medium");
  } finally { release(); }
  await switching;
  expect(efforts(1)).toEqual(["medium"]);
  await prompt(path);
  expect(efforts(1)).toEqual(["medium", "medium"]);
});

it("clamps effort on a non-reasoning fallback without losing the explicit choice on return", async () => {
  const modelsPath = join(base, "agent", "models.json");
  const config = JSON.parse(readFileSync(modelsPath, "utf8"));
  config.providers[models[1]!.provider].models[0].reasoning = false;
  writeFileSync(modelsPath, JSON.stringify(config));
  const path = await open(false);
  await prompt(path);
  await select(path, "high");
  answers[0] = () => ({ status: 429, body: { error: { message: "Rate limit reached. Please try again in 1s." } } });
  await prompt(path);
  expect(efforts(1)).toEqual([undefined]);
  expect(await reload(path)).toMatchObject({ thinkingLevel: "off", model: models[1] });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  answers[0] = () => ({ text: "returned" });
  answers[1] = () => ({ status: 500, body: { error: { message: "Internal server error" } } });
  await prompt(path);
  expect(efforts().at(-1)).toBe("high");
  expect((await reload(path)).thinkingLevel).toBe("high");
});
