/**
 * M13-T3 · Namer: title post-processing, cheap-candidate nomination (pure),
 * the per-session label throttle, and the qualification benchmark against a
 * fake runtime.
 */
import { SESSION_NAME_MAX, type ModelCatalogEntry } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { NamerService, QUALIFY_SAMPLE, cleanSessionName, cleanToolLabel, nominateNamerCandidates, type NamerModelRuntime } from "../../src/agents/namer.js";

function entry(provider: string, id: string, cost?: { input?: number; output?: number }): ModelCatalogEntry {
  return { provider, id, name: id, contextWindow: 1, reasoning: false, vision: false, thinkingLevels: ["off"], enabled: true, ...(cost ? { cost } : {}) };
}

describe("cleanSessionName", () => {
  it("strips quotes, labels, trailing punctuation and doubled spaces", () => {
    expect(cleanSessionName('"Fix login form   submit."')).toBe("Fix login form submit");
    expect(cleanSessionName("Title: Rename the auth module!\nSecond line")).toBe("Rename the auth module");
    expect(cleanSessionName("  **Tidy imports**  ")).toBe("Tidy imports");
  });
  it("cuts at a word boundary within the ceiling", () => {
    const long = cleanSessionName("Refactor the authentication refresh token handling code");
    expect(long.length).toBeLessThanOrEqual(SESSION_NAME_MAX);
    expect(long).toBe("Refactor the authentication");
    expect(cleanSessionName("a".repeat(50)).length).toBe(SESSION_NAME_MAX);
    expect(cleanSessionName("")).toBe("");
  });
});

describe("cleanToolLabel", () => {
  it("is one capitalised line of at most 40 characters without a trailing period", () => {
    expect(cleanToolLabel("searching auth handlers.")).toBe("Searching auth handlers");
    expect(cleanToolLabel('"Reading the build configuration for the desktop shell"').length).toBeLessThanOrEqual(40);
  });
});

describe("nominateNamerCandidates", () => {
  it("keeps cheap connected models, prefers small names, sorts by cost then name, caps at six", () => {
    const models = [
      entry("openai", "gpt-5-pro", { input: 10, output: 30 }),
      entry("openai", "gpt-5-mini", { input: 0.25, output: 2 }),
      entry("openai", "gpt-5-nano", { input: 0.05, output: 0.4 }),
      entry("anthropic", "claude-haiku", { input: 0.8, output: 4 }),
      entry("anthropic", "claude-opus", { input: 15, output: 75 }),
      entry("google", "gemini-flash", { input: 0.1, output: 0.4 }),
      entry("google", "gemini-ultra", { input: 1, output: 1 }),
      entry("mistral", "mistral-small", { input: 0.2, output: 0.6 }),
      entry("mistral", "ministral", { input: 0.1, output: 0.1 }),
      entry("mistral", "codestral", { input: 0.3, output: 0.9 }),
      entry("xai", "grok-mini", { input: 0.3, output: 0.5 }),
      entry("nobody", "free-lite"),
      entry("local", "big-thing", { input: 0, output: 0 }),
    ];
    const configured = new Set(["openai", "anthropic", "google", "mistral", "xai", "local"]);
    const picked = nominateNamerCandidates(models, configured).map((m) => `${m.provider}/${m.id}`);
    expect(picked).toHaveLength(6);
    expect(picked).not.toContain("openai/gpt-5-pro");
    expect(picked).not.toContain("anthropic/claude-opus");
    expect(picked).not.toContain("google/gemini-ultra");
    expect(picked).not.toContain("nobody/free-lite");
    // haiku costs 4.8 > ceiling, so it is out; small names come first, cheapest first.
    expect(picked.slice(0, 4)).toEqual(["mistral/ministral", "openai/gpt-5-nano", "google/gemini-flash", "mistral/mistral-small"]);
    expect(picked).not.toContain("anthropic/claude-haiku");
    expect(nominateNamerCandidates(models, new Set())).toEqual([]);
    // A model the person switched off is not a candidate.
    const off = models.map((model) => (model.id === "ministral" ? { ...model, enabled: false } : model));
    expect(nominateNamerCandidates(off, configured)[0]).toMatchObject({ id: "gpt-5-nano" });
  });
});

function fakeRuntime(answer: (context: { messages: Array<{ content: string }> }) => string | Promise<string>, models = [{ provider: "stub", id: "stub-1" }]): NamerModelRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    async completeSimple(_model: unknown, context: { messages: Array<{ content: string }> }, options?: { signal?: AbortSignal }) {
      runtime.calls += 1;
      const text = await answer(context);
      options?.signal?.throwIfAborted();
      return { content: [{ type: "text", text }] };
    },
  };
  return runtime;
}

describe("NamerService", () => {
  it("names a session from its first prompt, and does nothing without a model", async () => {
    const runtime = fakeRuntime(() => '"Fix login form submit."');
    let model: { provider: string; id: string } | null = null;
    const namer = new NamerService({ models: async () => runtime, model: () => model });
    expect(namer.enabled()).toBe(false);
    expect(await namer.nameSession("please fix the login form")).toBeNull();
    model = { provider: "stub", id: "stub-1" };
    expect(await namer.nameSession("please fix the login form")).toBe("Fix login form submit");
    expect(runtime.calls).toBe(1);
  });

  it("swallows failures and unknown models", async () => {
    const failing = fakeRuntime(() => { throw new Error("boom"); });
    const namer = new NamerService({ models: async () => failing, model: () => ({ provider: "stub", id: "stub-1" }) });
    expect(await namer.nameSession("x")).toBeNull();
    const missing = new NamerService({ models: async () => fakeRuntime(() => "ok", []), model: () => ({ provider: "stub", id: "nope" }) });
    expect(await missing.nameSession("x")).toBeNull();
  });

  it("labels every call in a burst at once, per session, with no cap", async () => {
    const pending: Array<(value: string) => void> = [];
    const runtime = fakeRuntime(() => new Promise<string>((resolve) => pending.push(resolve)));
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const namer = new NamerService({ models: async () => runtime, model: () => ({ provider: "stub", id: "stub-1" }) });
    // A turn that fires four calls in one tick: all four are asked about, at
    // once — the person is looking at exactly the row that would otherwise go
    // unlabelled. Another session's burst is independent.
    const burst = [
      namer.labelTool("/s1", "t1", "grep", { pattern: "auth" }),
      namer.labelTool("/s1", "t2", "read", { path: "x" }),
      namer.labelTool("/s1", "t3", "bash", { command: "ls" }),
      namer.labelTool("/s1", "t4", "read", { path: "z" }),
    ];
    const other = namer.labelTool("/s2", "t5", "read", { path: "y" });
    await settle();
    expect(pending).toHaveLength(5);
    pending[0]!("searching auth handlers.");
    pending[1]!("reading x");
    pending[2]!("listing files");
    pending[3]!("reading z");
    pending[4]!("reading y");
    expect(await Promise.all(burst)).toEqual(["Searching auth handlers", "Reading x", "Listing files", "Reading z"]);
    expect(await other).toBe("Reading y");
    expect(runtime.calls).toBe(5);
    // The same call id is never asked about twice; a fresh one is.
    expect(await namer.labelTool("/s1", "t1", "grep", { pattern: "auth" })).toBeNull();
    const later = namer.labelTool("/s1", "t6", "bash", { command: "pwd" });
    await settle();
    pending[5]!("printing the directory");
    expect(await later).toBe("Printing the directory");
  });

  it("labels one call id once, even after the slot frees", async () => {
    const runtime = fakeRuntime(() => "reading x");
    const namer = new NamerService({ models: async () => runtime, model: () => ({ provider: "stub", id: "stub-1" }) });
    expect(await namer.labelTool("/s1", "t1", "read", { path: "x" })).toBe("Reading x");
    expect(await namer.labelTool("/s1", "t1", "read", { path: "x" })).toBeNull();
    expect(runtime.calls).toBe(1);
    // The same id in another session is another call, and `forget` clears the memory.
    expect(await namer.labelTool("/s2", "t1", "read", { path: "x" })).toBe("Reading x");
    namer.forget("/s1");
    expect(await namer.labelTool("/s1", "t1", "read", { path: "x" })).toBe("Reading x");
    expect(runtime.calls).toBe(3);
  });

  it("pays for no label the call will not show", async () => {
    let running = false;
    const runtime = fakeRuntime(() => "reading x");
    const namer = new NamerService({ models: async () => runtime, model: () => ({ provider: "stub", id: "stub-1" }) });
    // Already finished when the label was asked for: no completion at all.
    expect(await namer.labelTool("/s1", "t1", "read", { path: "x" }, { stillRunning: () => running })).toBeNull();
    expect(runtime.calls).toBe(0);
    // Finished while the completion was in flight: the answer is dropped.
    running = true;
    const ended = fakeRuntime(() => {
      running = false;
      return "reading x";
    });
    const late = new NamerService({ models: async () => ended, model: () => ({ provider: "stub", id: "stub-1" }) });
    expect(await late.labelTool("/s1", "t2", "read", { path: "x" }, { stillRunning: () => running })).toBeNull();
    expect(ended.calls).toBe(1);
    // Still running: the label is kept.
    running = true;
    expect(await namer.labelTool("/s1", "t3", "read", { path: "x" }, { stillRunning: () => running })).toBe("Reading x");
  });

  it("qualifies the fastest valid cheap model and reports every candidate", async () => {
    let now = 0;
    const latency: Record<string, number> = { "fast-mini": 100, "slow-nano": 400, "bad-lite": 50 };
    const runtime: NamerModelRuntime = {
      getModel: (provider, id) => ({ provider, id }),
      async completeSimple(model, context) {
        expect(context.messages[0]!.content).toContain(QUALIFY_SAMPLE);
        const m = model as { id: string };
        now += latency[m.id] ?? 0;
        if (m.id === "bad-lite") return { content: [{ type: "text", text: "This title is far too long to be a valid session name at all" }] };
        return { content: [{ type: "text", text: `Fix login form via ${m.id}` }] };
      },
    };
    const namer = new NamerService({
      models: async () => runtime,
      model: () => null,
      now: () => now,
      catalog: async () => ({
        models: [entry("p", "fast-mini", { input: 0.1, output: 0.1 }), entry("p", "slow-nano", { input: 0.1, output: 0.1 }), entry("p", "bad-lite", { input: 0.1, output: 0.1 }), entry("p", "gpt-pro", { input: 1, output: 1 })],
        configuredProviders: new Set(["p"]),
      }),
    });
    const state = await namer.qualify();
    expect(state.status).toBe("ready");
    expect(state.model).toEqual({ provider: "p", id: "fast-mini" });
    expect(state.candidates.map((c) => `${c.model.id}:${c.valid}:${c.latencyMs}`)).toEqual(["bad-lite:false:50", "fast-mini:true:100", "slow-nano:true:400"]);
    expect(state.candidates[1]?.costPerMillion).toBeCloseTo(0.2);
    expect(state.qualifiedAt).toBeDefined();
  });

  it("is unavailable with a reason when nothing can be nominated", async () => {
    const namer = new NamerService({ models: async () => fakeRuntime(() => "x"), model: () => null, catalog: async () => ({ models: [entry("p", "gpt-pro")], configuredProviders: new Set(["p"]) }) });
    expect(await namer.qualify()).toMatchObject({ status: "unavailable", model: null, candidates: [], reason: expect.stringMatching(/Connect a provider/) });
  });
});
