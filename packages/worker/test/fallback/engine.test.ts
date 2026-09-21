/**
 * M15-T3 against the real engine: three stub providers, a real chain in the
 * real settings file, and the real driver. The stub answers with the HTTP
 * statuses a provider actually sends (429 with `retry-after`, 402, 500) or
 * drops the socket, so the engine's own retry loop runs and gives up exactly
 * as it does in production — which is where a fallback begins.
 *
 * What is proven here and nowhere else: that the engine's retries finish
 * first, that the same turn continues on the new model without replaying a
 * tool or duplicating a message, that a return to an earlier model is one
 * request, that a chain is never entered recursively, that reload keeps the
 * traversal, that a person's own choice wins, and that nothing reaches a model
 * in the background.
 */
import { PRODUCT_NAME, type ModelRef, type SessionUpdate } from "@lasercode/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { fallbackDefaultAgent, fallbackPolicy } from "../../src/agents/definitions.js";
import { rootRecord, rootRole } from "../../src/agents/session-config.js";
import { StableSdkDriver } from "../../src/drivers/stable-sdk.js";
import type { DriverAgentOptions, DriverEvent } from "../../src/driver.js";
import { startStubProvider, type StubAnswer, type StubProvider, type StubRequest } from "../agents/stub-provider.js";

type Which = "a" | "b" | "c";

const MODEL: Record<Which, { provider: string; id: string }> = {
  a: { provider: "stub", id: "stub-1" },
  b: { provider: "stub-b", id: "stub-b-1" },
  c: { provider: "stub-c", id: "stub-c-1" },
};

let base: string;
let project: string;
let agentDir: string;
let stubs: Record<Which, StubProvider>;
/** What each provider answers, by request index. A test replaces these. */
let script: Record<Which, (request: StubRequest, index: number) => StubAnswer>;
let drivers: StableSdkDriver[];

const ok = (text: string): StubAnswer => ({ text });
const down = (): StubAnswer => ({ status: 500, body: { error: { message: "Internal server error" } } });
/**
 * A throttle the provider explains, the way providers explain one. The stated
 * delay is the evidence the chain uses: a failed request never reaches the
 * engine's response hook, so its headers are not available to anything above
 * the provider SDK.
 */
const throttled = (seconds: number): StubAnswer => ({
  status: 429,
  headers: { "retry-after": String(seconds) },
  body: { error: { message: `Rate limit reached. Please try again in ${seconds}s.` } },
});
const broke = (): StubAnswer => ({ status: 402, body: { error: { code: "insufficient_quota", message: "You exceeded your current quota" } } });

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-fallback-`));
  project = join(base, "project");
  agentDir = join(base, "agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(base, "sessions"), { recursive: true });
  drivers = [];
  script = { a: () => ok("from a"), b: () => ok("from b"), c: () => ok("from c") };
  const started = await Promise.all(
    (["a", "b", "c"] as Which[]).map(async (which) => [which, await startStubProvider((request, index) => script[which](request, index))] as const),
  );
  stubs = Object.fromEntries(started) as Record<Which, StubProvider>;
  writeStubs();
});

afterEach(async () => {
  for (const driver of drivers) await driver.dispose().catch(() => {});
  await Promise.all(Object.values(stubs).map((stub) => stub.close()));
  rmSync(base, { recursive: true, force: true });
});

/** Stable profile ids, so a test can name the profile it wrote. */
const profileId = (index: number) => `mp_testprofile${index}0000000000`;
const PROFILE_AT = "2026-01-01T00:00:00.000Z";

function writeStubs(
  models: Array<{ provider: string; id: string }> = [MODEL.a, MODEL.b, MODEL.c],
  extraProfiles: Array<{ models: Array<{ provider: string; id: string }> }> = [],
  defaultModel: { provider: string; id: string } = MODEL.a,
  options: { windows?: Partial<Record<Which, number>>; compaction?: Record<string, unknown>; unauthenticated?: readonly Which[] } = {},
): void {
  mkdirSync(agentDir, { recursive: true });
  const windowOf = (which: Which, fallback: number) => options.windows?.[which] ?? fallback;
  /** A provider the person never signed in to: in the catalogue, unusable. */
  const keyOf = (which: Which) => (options.unauthenticated?.includes(which) ? {} : { apiKey: "k" });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl: stubs.a.url, api: "openai-completions", ...keyOf("a"), models: [{ id: "stub-1", name: "Stub A", contextWindow: windowOf("a", 8000), maxTokens: 1000 }] },
        "stub-b": { baseUrl: stubs.b.url, api: "openai-completions", ...keyOf("b"), models: [{ id: "stub-b-1", name: "Stub B", contextWindow: windowOf("b", 8000), maxTokens: 1000 }] },
        "stub-c": { baseUrl: stubs.c.url, api: "openai-completions", ...keyOf("c"), models: [{ id: "stub-c-1", name: "Stub C", contextWindow: windowOf("c", 8000), maxTokens: 1000 }] },
      },
    }),
  );
  const profiles = [
    ...(models.length > 0 ? [{ id: profileId(0), name: "Balanced", models, origin: "person", updatedAt: PROFILE_AT }] : []),
    ...extraProfiles.map((profile, index) => ({
      id: profileId(index + 1),
      name: `Profile ${index + 1}`,
      models: profile.models,
      origin: "person",
      updatedAt: PROFILE_AT,
    })),
  ];
  let defaultProfileId = profiles.find((profile) => profile.models[0]?.provider === defaultModel.provider && profile.models[0]?.id === defaultModel.id)?.id;
  if (profiles.length > 0 && !defaultProfileId) {
    defaultProfileId = profileId(9);
    profiles.push({ id: defaultProfileId, name: "Default", models: [defaultModel], origin: "person", updatedAt: PROFILE_AT });
  }
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      // The engine's own default, left in place by the migration (D-346). It
      // is the last resort for a person who has no profiles at all.
      defaultProvider: defaultModel.provider,
      defaultModel: defaultModel.id,
      // The engine's own retry policy, kept short so a test spends
      // milliseconds where production spends seconds. It is still the engine's
      // loop: `maxRetries` attempts after the first, exponential backoff.
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 5 },
      ...(options.compaction ? { compaction: options.compaction } : {}),
      ...(profiles.length > 0 ? { modelProfiles: profiles, defaultProfileId } : {}),
    }),
  );
}

interface Opened {
  driver: StableSdkDriver;
  updates: SessionUpdate[];
  path: string;
}

/**
 * Captured from inside the session, so a test can wake a turn the way a child
 * agent's ending and a background command's exit do (`pi.sendMessage` with
 * `triggerTurn`). It is fire-and-forget for the extension, so a caller waits
 * for the turn it started.
 */
let wake: ((text: string) => void) | undefined;
const waker: InlineExtension = (pi) => {
  wake = (text: string) => {
    pi.sendMessage({ customType: "test/wake", content: text, display: false }, { triggerTurn: true });
  };
};

async function waitFor(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await wait(20);
  }
}

/** Wake a turn and wait for it to settle, the way the harness waits for a run. */
async function woken(updates: SessionUpdate[], text: string): Promise<void> {
  const before = updates.filter((update) => update.kind === "agent_settled").length;
  wake!(text);
  await waitFor(() => updates.filter((update) => update.kind === "agent_settled").length > before, `the woken turn to settle (${text})`);
  await wait(50);
}

async function open(sessionPath?: string, agent?: DriverAgentOptions): Promise<Opened> {
  const driver = new StableSdkDriver([waker]);
  drivers.push(driver);
  const updates: SessionUpdate[] = [];
  driver.subscribe((event: DriverEvent) => {
    if (event.type === "update") updates.push(event.update);
  });
  const state = await driver.open({
    cwd: project,
    agentDir,
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: [],
    ...(sessionPath ? { sessionPath } : {}),
    ...(agent ? { agent } : {}),
  });
  return { driver, updates, path: state.path };
}

const requests = (which: Which) => stubs[which].requests.length;
const fallbacks = (updates: SessionUpdate[]) => updates.filter((u): u is Extract<SessionUpdate, { kind: "model_fallback" }> => u.kind === "model_fallback");
const modelOf = (driver: StableSdkDriver): ModelRef | null => driver.state().model;
const idOf = (driver: StableSdkDriver) => modelOf(driver)?.id;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- the trigger

it("lets the engine finish its own retries, then continues the turn on the next model", async () => {
  script.a = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  // The engine's policy is `maxRetries: 1`: the first request plus one retry,
  // and only then does the chain get a say.
  expect(requests("a")).toBe(2);
  expect(updates.filter((u) => u.kind === "auto_retry_start")).toHaveLength(1);
  expect(requests("b")).toBe(1);
  expect(idOf(driver)).toBe("stub-b-1");

  const events = fallbacks(updates);
  expect(events.map((event) => event.phase)).toEqual(["switching", "switched"]);
  expect(events[1]!.to?.id).toBe("stub-b-1");
  expect(events[1]!.reason).toBe("provider_down");
  expect(events[1]!.detail).toContain("Stub A is not answering");
  // The state a client reads says where in the chain it now is, and is quiet
  // again once the switch is done.
  expect(driver.state().fallback).toMatchObject({ position: 1 });
  expect(driver.state().fallback?.switching).toBeUndefined();
  expect(driver.state().isStreaming).toBe(false);
});

it("stamps the profile in force on every captured provider request, and none on a pinned session", async () => {
  const { driver } = await open();
  const captures: string[] = [];
  driver.subscribe((event: DriverEvent) => {
    if (event.type === "extension" && event.message.type === "lasercode/provider/request") {
      captures.push(event.message.context?.profileId ?? "none");
    }
  });
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(captures.length).toBeGreaterThan(0);
  expect(new Set(captures)).toEqual(new Set([driver.state().profile!.id]));

  // A pinned session has no profile to attribute: the capture says nothing.
  await driver.setModel(MODEL.b);
  const before = captures.length;
  await driver.prompt([{ type: "text", text: "again" }]);
  expect(captures.slice(before)).toEqual(["none"]);
});

it("holds the engine's settle until the chain has finished, so a run is never ended early", async () => {
  script.a = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  const settled = updates.findIndex((u) => u.kind === "agent_settled");
  const switched = updates.findIndex((u) => u.kind === "model_fallback" && u.phase === "switched");
  expect(settled).toBeGreaterThan(-1);
  expect(switched).toBeGreaterThan(-1);
  // One settle, after the switch: the harness ends a run on this update.
  expect(updates.filter((u) => u.kind === "agent_settled")).toHaveLength(1);
  expect(settled).toBeGreaterThan(switched);
});

it("switches on a spent account, and not on an error it cannot name", async () => {
  script.a = () => broke();
  const first = await open();
  await first.driver.prompt([{ type: "text", text: "hello" }]);
  expect(idOf(first.driver)).toBe("stub-b-1");
  expect(fallbacks(first.updates).at(-1)?.reason).toBe("credits");

  // An error with no recognisable shape is left exactly as it is today: the
  // turn keeps its failure and no model is changed behind the person's back.
  script.a = () => ({ status: 418, body: { error: { message: "the assistant produced an unusable answer" } } });
  const second = await open();
  await second.driver.prompt([{ type: "text", text: "hello" }]);
  expect(idOf(second.driver)).toBe("stub-1");
  expect(fallbacks(second.updates)).toEqual([]);
});

it("does not treat a tool failure or an ordinary answer as a reason to change model", async () => {
  let call = 0;
  script.a = () => {
    call++;
    // A tool that fails, then an answer describing the failure: the assistant
    // turn succeeded both times, which is the whole point.
    return call === 1
      ? { toolCall: { name: "bash", args: { command: "exit 3" } } }
      : ok("The command failed with exit code 3.");
  };
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "run it" }]);
  expect(idOf(driver)).toBe("stub-1");
  expect(requests("b")).toBe(0);
  expect(fallbacks(updates)).toEqual([]);
});

// ------------------------------------------------------------- continuity

it("continues the same task on the new provider without replaying a tool or repeating a message", async () => {
  const marker = join(base, "ran");
  let aCalls = 0;
  script.a = () => {
    aCalls++;
    return aCalls === 1
      ? { toolCall: { name: "bash", args: { command: `echo one >> ${JSON.stringify(marker).slice(1, -1)}` } } }
      : down();
  };
  script.b = () => ok("finished on b");
  const { driver } = await open();
  await driver.prompt([{ type: "text", text: "do the thing" }]);

  expect(idOf(driver)).toBe("stub-b-1");
  const handover = stubs.b.requests[0]!;
  const users = handover.messages.filter((m) => m.role === "user");
  expect(users).toHaveLength(1);
  // The tool call and its result are in the new provider's very first request:
  // the work already done is context, not something to do again.
  expect(handover.messages.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)).toBe(true);
  expect(handover.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  // And the failed attempt is not part of what the new model is asked to read.
  expect(JSON.stringify(handover.messages)).not.toContain("Internal server error");
  expect(requests("b")).toBe(1);
});

// --------------------------------------------------- return, order, bounds

it("tries an earlier model once when its cooldown has passed, and keeps the rest of the chain", async () => {
  // A is throttled with a one-second reset, so the second turn may reconsider
  // it; B then fails, and A gets exactly one request — no retry cycle.
  // The engine's own retry runs first, so A must refuse both of its requests
  // before the chain is consulted at all.
  script.a = (_request, index) => (index < 2 ? throttled(1) : ok("back on a"));
  let bCalls = 0;
  script.b = () => {
    bCalls++;
    return bCalls === 1 ? ok("from b") : down();
  };
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "first" }]);
  expect(idOf(driver)).toBe("stub-b-1");
  const afterFirst = requests("a");

  await wait(1_100);
  await driver.prompt([{ type: "text", text: "second" }]);

  expect(idOf(driver)).toBe("stub-1");
  // One request, not a retry cycle: B's own failure used the engine's policy
  // (two requests), the return to A used a single one.
  expect(requests("a")).toBe(afterFirst + 1);
  expect(driver.state().fallback).toMatchObject({ position: 0 });
  // The chain is intact: C is still behind B.
  expect(driver.state().fallback?.models.map((model) => model.id)).toEqual(["stub-1", "stub-b-1", "stub-c-1"]);
  expect(fallbacks(updates).at(-1)).toMatchObject({ phase: "switched", reason: "provider_down" });
});

it("skips an earlier model that failed moments ago and advances instead", async () => {
  script.a = () => down();
  script.b = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  // A failed seconds ago: its cooldown holds, so the traversal goes forward to
  // C rather than knocking on A's door again.
  expect(idOf(driver)).toBe("stub-c-1");
  expect(requests("a")).toBe(2);
  expect(requests("b")).toBe(2);
  expect(requests("c")).toBe(1);
  expect(fallbacks(updates).map((event) => event.phase)).toEqual(["switching", "attempt_failed", "switched"]);
});

it("preserves the task with one actionable error when the whole profile is spent", async () => {
  script.a = () => down();
  script.b = () => down();
  script.c = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  const exhausted = fallbacks(updates).at(-1)!;
  expect(exhausted.phase).toBe("exhausted");
  expect(exhausted.detail).toContain("Stub C is not answering");
  // The session is idle, re-promptable, and on the model that failed last.
  expect(driver.state().isStreaming).toBe(false);
  expect(idOf(driver)).toBe("stub-c-1");
  const before = requests("a") + requests("b") + requests("c");
  // Nothing is scheduled: no probe, no timer, no second traversal.
  await wait(200);
  expect(requests("a") + requests("b") + requests("c")).toBe(before);
});

it("never leaves the session's own profile, however many profiles there are", async () => {
  // One profile A → B, and another B → C. A session on the first moves to B
  // and stops there: the second profile is a different intent, not a spare
  // model (docs/model-profiles.md, "Runtime").
  writeStubs([MODEL.a, MODEL.b], [{ models: [MODEL.b, MODEL.c] }]);
  script.a = () => down();
  script.b = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  expect(requests("c")).toBe(0);
  expect(idOf(driver)).toBe("stub-b-1");
  expect(fallbacks(updates).at(-1)?.phase).toBe("exhausted");
});

it("asks nothing of a model in the background while the active one works", async () => {
  script.a = () => down();
  script.b = () => ok("from b");
  const { driver } = await open();
  await driver.prompt([{ type: "text", text: "one" }]);
  const afterSwitch = requests("a");

  for (const text of ["two", "three", "four"]) await driver.prompt([{ type: "text", text }]);
  await wait(200);
  expect(requests("a")).toBe(afterSwitch);
  expect(requests("b")).toBe(4);
  expect(idOf(driver)).toBe("stub-b-1");
});

// ------------------------------------------------------ reload and the person

it("keeps the profile, the position and the eligibility across a reload", async () => {
  writeStubs([MODEL.a, MODEL.b], [{ models: [MODEL.b, MODEL.c] }]);
  script.a = () => down();
  script.b = () => ok("from b");
  const first = await open();
  await first.driver.prompt([{ type: "text", text: "hello" }]);
  expect(idOf(first.driver)).toBe("stub-b-1");
  const path = first.path;
  await first.driver.dispose();

  const again = await open(path);
  // The profile is the one this conversation activated, at the position it
  // reached — not one resolved afresh from the model it is on.
  expect(again.driver.state().fallback).toMatchObject({ position: 1 });
  expect(again.driver.state().fallback?.models.map((model) => model.id)).toEqual(["stub-1", "stub-b-1"]);

  // And the failure history came with it: B failing now finds A still in
  // cooldown and the profile spent, rather than starting again at the top.
  script.b = () => down();
  await again.driver.prompt([{ type: "text", text: "again" }]);
  expect(requests("c")).toBe(0);
  expect(fallbacks(again.updates).at(-1)?.phase).toBe("exhausted");
});

it("pins to one model on a person's choice, and re-anchors when they pick a profile", async () => {
  script.a = () => down();
  script.b = () => ok("from b");
  const { driver } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(driver.state().fallback).toMatchObject({ position: 1 });
  expect(driver.state().profile).toMatchObject({ id: profileId(0), name: "Balanced" });

  // Choosing a model is pinning: the session leaves its profile and has
  // nothing standing in for C.
  await driver.setModel({ provider: "stub-c", id: "stub-c-1" });
  expect(driver.state().fallback).toBeUndefined();
  expect(driver.state().profile).toBeNull();
  expect(driver.state().pinned).toBe(true);
  expect(idOf(driver)).toBe("stub-c-1");

  // Choosing the profile again re-anchors to its first model, and the mark A
  // earned is cleared, so A is tried and answers.
  script.a = () => ok("back on a");
  await driver.setProfile(profileId(0));
  expect(driver.state().fallback).toMatchObject({ position: 0 });
  expect(driver.state().pinned).toBeUndefined();
  await driver.prompt([{ type: "text", text: "again" }]);
  expect(idOf(driver)).toBe("stub-1");
});

it("has no profile at all, and behaves exactly as before, when a person has none", async () => {
  writeStubs([]);
  script.a = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(driver.state().fallback).toBeUndefined();
  expect(driver.state().profile).toBeNull();
  expect(fallbacks(updates)).toEqual([]);
  expect(requests("b")).toBe(0);
  expect(idOf(driver)).toBe("stub-1");
});

it("activates the agent's own profile when its first turn is accepted", async () => {
  // The session opens on the unrelated default profile. Selecting this agent
  // replaces that pristine runtime before the first prompt; the activation
  // must follow the profile the accepted runtime is actually on.
  writeStubs([MODEL.a, MODEL.b], [], MODEL.c);
  script.a = () => down();
  script.b = () => ok("continued on b");
  const original = { ...fallbackDefaultAgent(), profileId: null };
  const originalOptions = {
    definition: original,
    role: rootRole(original.name),
    record: rootRecord(original.name),
    policy: fallbackPolicy(),
  };
  const seeded = await open(undefined, originalOptions);
  const path = seeded.path;
  await seeded.driver.dispose();

  const { driver, updates } = await open(path, originalOptions);
  expect(idOf(driver)).toBe("stub-c-1");
  // The default profile holds one model, so there is an activation — with
  // nothing to move to, which is not the same as having no profile.
  expect(driver.state().fallback).toMatchObject({ profileId: profileId(9), position: 0 });

  const definition = { ...fallbackDefaultAgent(), name: "reviewer", profileId: profileId(0) };
  await driver.prepareFirstTurn({
    agent: {
      definition,
      role: rootRole(definition.name),
      record: rootRecord(definition.name),
      policy: fallbackPolicy(),
    },
  });
  await driver.prompt([{ type: "text", text: "review this" }]);

  expect(requests("a")).toBe(2);
  expect(requests("b")).toBe(1);
  expect(idOf(driver)).toBe("stub-b-1");
  expect(driver.state().fallback).toMatchObject({ position: 1 });
  expect(fallbacks(updates).at(-1)).toMatchObject({ phase: "switched", to: { id: "stub-b-1" } });
});

it("starts a conversation on the first model of its profile it can reach", async () => {
  // The profile prefers A, and this machine has no credential for it. The
  // session must open on B — the person's first prompt is not the place to
  // discover that (`docs/model-profiles.md`, "Runtime").
  writeStubs([MODEL.a, MODEL.b, MODEL.c], [], MODEL.a, { unauthenticated: ["a"] });
  script.b = () => ok("from b");
  const { driver, updates } = await open();

  expect(idOf(driver)).toBe("stub-b-1");
  expect(driver.state().fallback).toMatchObject({ profileId: profileId(0), position: 1 });
  expect(requests("a")).toBe(0);
  const started = fallbacks(updates).at(-1);
  expect(started).toMatchObject({ phase: "switched", to: { id: "stub-b-1" } });
  expect(started?.detail).toContain("not signed in");

  // And the first prompt is answered by the model it started on, first time.
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(requests("a")).toBe(0);
  expect(requests("b")).toBe(1);
  expect(idOf(driver)).toBe("stub-b-1");
});

it("walks the profile the accepted first turn brings, before that turn is asked of anyone", async () => {
  // The session opens on the default profile, which is reachable; the agent
  // chosen for the first turn names a profile whose preferred model is not.
  writeStubs([MODEL.a, MODEL.b], [], MODEL.c, { unauthenticated: ["a"] });
  script.b = () => ok("from b");
  const original = { ...fallbackDefaultAgent(), profileId: null };
  const { driver, updates } = await open(undefined, {
    definition: original,
    role: rootRole(original.name),
    record: rootRecord(original.name),
    policy: fallbackPolicy(),
  });
  expect(idOf(driver)).toBe("stub-c-1");

  const definition = { ...fallbackDefaultAgent(), name: "reviewer", profileId: profileId(0) };
  await driver.prepareFirstTurn({
    agent: {
      definition,
      role: rootRole(definition.name),
      record: rootRecord(definition.name),
      policy: fallbackPolicy(),
    },
  });

  // Prepared, and already on a model this machine can use: the host's own
  // availability check runs here, before the prompt is offered at all.
  expect(idOf(driver)).toBe("stub-b-1");
  expect(driver.state().fallback).toMatchObject({ profileId: profileId(0), position: 1 });
  await driver.prompt([{ type: "text", text: "review this" }]);
  expect(requests("a")).toBe(0);
  expect(requests("b")).toBe(1);
  expect(fallbacks(updates).at(-1)?.detail).toContain("not signed in");
});

it("does the same for a child agent's session, which is a session like any other", async () => {
  // The profile runtime lives in the driver, and a child agent run is a
  // session with its own driver (docs/agents.md), so a child gets the
  // behaviour with no harness code at all. Use an unrelated default profile to
  // prove the definition — not the default — chose the profile.
  writeStubs([MODEL.a, MODEL.b], [], MODEL.c);
  script.a = () => down();
  script.b = () => ok("from b");
  const definition = { ...fallbackDefaultAgent(), profileId: profileId(0) };
  const parentPath = join(base, "sessions", "parent.jsonl");
  const driver = new StableSdkDriver();
  drivers.push(driver);
  const updates: SessionUpdate[] = [];
  driver.subscribe((event: DriverEvent) => {
    if (event.type === "update") updates.push(event.update);
  });
  await driver.open({
    cwd: project,
    agentDir,
    sessionDir: join(base, "sessions"),
    projectTrusted: true,
    features: [],
    agent: {
      definition,
      role: { ...rootRole(definition.name), kind: "child", subagentName: "fixer", depth: 1, isolated: false, parent: { sessionPath: parentPath, sessionId: "parent", agentName: definition.name } },
      record: { ...rootRecord(definition.name), kind: "child", subagentName: "fixer", parentPath },
      policy: fallbackPolicy(),
    },
  });
  await driver.prompt([{ type: "text", text: "do the work" }]);

  expect(idOf(driver)).toBe("stub-b-1");
  expect(fallbacks(updates).at(-1)?.phase).toBe("switched");
  const settled = updates.findIndex((update) => update.kind === "agent_settled");
  const switched = updates.findIndex((update) => update.kind === "model_fallback" && update.phase === "switched");
  expect(settled).toBeGreaterThan(switched);
});


// ------------------------------------------------------- the turns nobody typed

it("falls back on a turn an extension woke, and settles it exactly once", async () => {
  // This is how a child agent's ending and a background command's exit reach
  // the model (D-158/D-162): an extension send that starts a turn of its own.
  // It never goes through `prompt()`, and a run that is never settled is a
  // parent that waits forever.
  script.a = () => down();
  script.b = () => ok("from b");
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "first" }]);
  expect(idOf(driver)).toBe("stub-b-1");
  const before = updates.length;

  script.b = () => down();
  script.c = () => ok("from c");
  await woken(updates, "a background command finished");

  expect(idOf(driver)).toBe("stub-c-1");
  const after = updates.slice(before);
  expect(fallbacks(after).at(-1)).toMatchObject({ phase: "switched", to: { id: "stub-c-1" } });
  expect(after.filter((update) => update.kind === "agent_settled")).toHaveLength(1);
});

it("settles a woken turn whose failure no profile can answer, and drains what was queued", async () => {
  // The excluded case: the turn fails for a reason that is not model access,
  // so nothing switches — but the settle must still arrive, once.
  script.a = () => ({ status: 400, body: { error: { message: "messages[3].role is not allowed for this endpoint" } } });
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "first" }]).catch(() => {});
  const before = updates.length;
  await woken(updates, "and again");
  const after = updates.slice(before);
  expect(fallbacks(after)).toEqual([]);
  expect(idOf(driver)).toBe("stub-1");
  expect(after.filter((update) => update.kind === "agent_settled")).toHaveLength(1);
  expect(driver.state().isStreaming).toBe(false);
});

// ------------------------------------------------------------------ the bounds

it("skips a model it has no credential for, once, and advances past it", async () => {
  // The middle model is in the catalogue and has no key: `setModel` would
  // refuse it, so it is skipped with a reason rather than tried in a loop.
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl: stubs.a.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-1", name: "Stub A", contextWindow: 8000, maxTokens: 1000 }] },
        "stub-b": { baseUrl: stubs.b.url, api: "openai-completions", models: [{ id: "stub-b-1", name: "Stub B", contextWindow: 8000, maxTokens: 1000 }] },
        "stub-c": { baseUrl: stubs.c.url, api: "openai-completions", apiKey: "k", models: [{ id: "stub-c-1", name: "Stub C", contextWindow: 8000, maxTokens: 1000 }] },
      },
    }),
  );
  script.a = () => down();
  script.c = () => ok("from c");
  const { driver } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);

  expect(requests("b")).toBe(0);
  expect(requests("c")).toBe(1);
  expect(idOf(driver)).toBe("stub-c-1");
  // And again on the next turn: still no loop, still one request each.
  script.c = () => ok("still c");
  await driver.prompt([{ type: "text", text: "again" }]);
  expect(requests("b")).toBe(0);
  expect(requests("c")).toBe(2);
});

it("keeps the position on the model the session ended on, so the badge is not a lie", async () => {
  script.a = () => down();
  script.b = () => down();
  script.c = () => down();
  const { driver } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(idOf(driver)).toBe("stub-c-1");
  // The selector draws `position+1 / length`; after an exhausted profile
  // that has to be 3/3, not 1/3.
  expect(driver.state().fallback).toMatchObject({ position: 2 });
  expect(driver.state().fallback?.models[2]?.id).toBe("stub-c-1");
});

it("treats a dropped connection as a reason to fall back", async () => {
  script.a = () => ({ drop: true });
  script.b = () => ok("from b");
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);
  expect(idOf(driver)).toBe("stub-b-1");
  expect(fallbacks(updates).at(-1)?.reason).toBe("connection");
});

// ------------------------------------------------------------ races and stops

it("gives a person's choice the last word over a switch already in flight", async () => {
  // A fails, the profile reaches for B, and B takes its time. The person pins C
  // meanwhile: their model is the one that stands, and the stale step neither
  // sets a model nor records anything afterwards.
  script.a = () => down();
  script.b = () => ({ text: "from b", delayMs: 400 });
  script.c = () => ok("from c");
  const { driver, updates } = await open();
  const turn = driver.prompt([{ type: "text", text: "hello" }]);
  while (requests("b") === 0) await wait(20);

  await driver.setModel(MODEL.c);
  await turn.catch(() => {});
  await wait(300);

  expect(idOf(driver)).toBe("stub-c-1");
  // C starts no chain of its own here, so the traversal is gone with it.
  expect(driver.state().fallback).toBeUndefined();
  expect(fallbacks(updates).some((event) => event.phase === "switched")).toBe(false);
  expect(driver.state().isStreaming).toBe(false);
});

it("does not fall back when the person stops the turn", async () => {
  script.a = () => ({ text: "slow", delayMs: 400 });
  const { driver, updates } = await open();
  const turn = driver.prompt([{ type: "text", text: "hello" }]);
  while (requests("a") === 0) await wait(20);
  await driver.abort();
  await turn.catch(() => {});
  await wait(200);

  expect(fallbacks(updates)).toEqual([]);
  expect(requests("b")).toBe(0);
  expect(idOf(driver)).toBe("stub-1");
});

it("does not open a second failover from a failure it already acted on", async () => {
  script.a = () => down();
  script.b = () => down();
  script.c = () => down();
  const { driver, updates } = await open();
  await driver.prompt([{ type: "text", text: "hello" }]);
  const exhausted = fallbacks(updates).filter((event) => event.phase === "exhausted");
  expect(exhausted).toHaveLength(1);

  // A goal action, a command, a compaction: an invocation that produces no
  // assistant message at all must not reopen the chain from the dead signal.
  await driver.compact().catch(() => {});
  await wait(100);
  expect(fallbacks(updates).filter((event) => event.phase === "exhausted")).toHaveLength(1);
});

const CHUNK = `note: ${"x".repeat(4_000)}`;
const fat = (text: string): StubAnswer => ({
  text,
  usage: { prompt_tokens: 7_000, completion_tokens: 50, total_tokens: 7_050 },
});

async function fillThenFail(driver: StableSdkDriver, fail: () => void): Promise<void> {
  script.a = () => fat("from a");
  for (let i = 0; i < 5; i++) await driver.prompt([{ type: "text", text: CHUNK }]);
  fail();
  await driver.prompt([{ type: "text", text: "continue" }]);
}

it("compacts so an oversized fallback can finish the same turn", async () => {
  writeStubs([MODEL.a, MODEL.b], [], MODEL.a, {
    windows: { a: 100_000, b: 4_000 },
    compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 0 },
  });
  script.b = () => ok("finished on b after compact");
  const { driver, updates } = await open();
  await fillThenFail(driver, () => {
    script.a = () => down();
  });

  expect(idOf(driver)).toBe("stub-b-1");
  expect(updates.some((update) => update.kind === "compaction_start")).toBe(true);
  expect(updates.some((update) => update.kind === "compaction_end" && update.ok)).toBe(true);
  const events = fallbacks(updates);
  expect(events.at(-1)).toMatchObject({ phase: "switched" });
  expect(events.at(-1)?.to?.id).toBe("stub-b-1");
  expect(requests("b")).toBeGreaterThanOrEqual(1);
  const settled = updates.findLastIndex((update) => update.kind === "agent_settled");
  const switched = updates.findIndex((update) => update.kind === "model_fallback" && update.phase === "switched");
  expect(settled).toBeGreaterThan(switched);
  expect(driver.state().isStreaming).toBe(false);
});

it("does not compact an oversized fallback when auto-compaction is off", async () => {
  writeStubs([MODEL.a, MODEL.b], [], MODEL.a, {
    windows: { a: 100_000, b: 4_000 },
    compaction: { enabled: false, keepRecentTokens: 200, reserveTokens: 0 },
  });
  script.b = () => ok("from b");
  const { driver, updates } = await open();
  await fillThenFail(driver, () => {
    script.a = () => down();
  });

  expect(requests("b")).toBe(0);
  expect(updates.some((update) => update.kind === "compaction_start")).toBe(false);
  const exhausted = fallbacks(updates).at(-1);
  expect(exhausted?.phase).toBe("exhausted");
  expect(exhausted?.detail).toContain("the conversation is longer than this model can hold");
});

it("does not replay a tool when compacting onto the oversized fallback", async () => {
  writeStubs([MODEL.a, MODEL.b], [], MODEL.a, {
    windows: { a: 100_000, b: 4_000 },
    compaction: { enabled: true, keepRecentTokens: 200, reserveTokens: 0 },
  });
  const marker = join(base, "ran-compact");
  script.b = () => ok("finished on b");
  const { driver } = await open();
  await fillThenFail(driver, () => {
    let aCalls = 0;
    script.a = () => {
      aCalls++;
      return aCalls === 1
        ? { toolCall: { name: "bash", args: { command: `echo one >> ${JSON.stringify(marker).slice(1, -1)}` } } }
        : down();
    };
  });

  expect(idOf(driver)).toBe("stub-b-1");
  const handover = stubs.b.requests.at(-1)!;
  expect(handover.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  expect(JSON.stringify(handover.messages)).not.toContain("Internal server error");
});
