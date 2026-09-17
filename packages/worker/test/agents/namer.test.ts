/**
 * M13-T3 · Namer: title post-processing, connected-candidate selection (pure),
 * and the session-title qualification benchmark against a fake runtime.
 */
import { SESSION_NAME_MAX, type ModelCatalogEntry } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { NamerService, QUALIFY_SAMPLE, cleanSessionName, normalizeSessionName, selectNamerCandidates, type NamerModelRuntime } from "../../src/agents/namer.js";

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

describe("tolerant naming output", () => {
  it("accepts common wrappers and safely shortens prose", () => {
    expect(normalizeSessionName('```json\n{"title":"Fix login submit"}\n```').value).toBe("Fix login submit");
    expect(normalizeSessionName("Title: Fix the login form and remove the successful sign-in error banner completely").value.length).toBeLessThanOrEqual(40);
  });
});

describe("selectNamerCandidates", () => {
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
    const picked = selectNamerCandidates(models, configured).map((m) => `${m.provider}/${m.id}`);
    expect(picked).toHaveLength(6);
    expect(picked).not.toContain("openai/gpt-5-pro");
    expect(picked).not.toContain("anthropic/claude-opus");
    expect(picked).not.toContain("google/gemini-ultra");
    expect(picked).not.toContain("nobody/free-lite");
    // haiku costs 4.8 > ceiling, so it is out; small names come first, cheapest first.
    expect(picked.slice(0, 4)).toEqual(["mistral/ministral", "openai/gpt-5-nano", "google/gemini-flash", "mistral/mistral-small"]);
    expect(picked).not.toContain("anthropic/claude-haiku");
    expect(selectNamerCandidates(models, new Set())).toEqual([]);
    // A model the person switched off is not a candidate.
    const off = models.map((model) => (model.id === "ministral" ? { ...model, enabled: false } : model));
    expect(selectNamerCandidates(off, configured)[0]).toMatchObject({ id: "gpt-5-nano" });
  });
});

function fakeRuntime(answer: (context: { systemPrompt?: string; messages: Array<{ content: string }> }) => string | Promise<string>, models = [{ provider: "stub", id: "stub-1" }]): NamerModelRuntime & { calls: number } {
  const runtime = {
    calls: 0,
    getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    async completeSimple(_model: unknown, context: { systemPrompt?: string; messages: Array<{ content: string }> }, options?: { signal?: AbortSignal }) {
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

  it("layers the editable Namer instructions into session-title requests", async () => {
    const prompts: string[] = [];
    const runtime = fakeRuntime((context) => {
      prompts.push(context.systemPrompt ?? "");
      return "Review auth redirects";
    });
    const namer = new NamerService({
      models: async () => runtime,
      model: () => ({ provider: "stub", id: "stub-1" }),
      instructions: () => "Prefer concrete nouns from the person's request.",
    });
    await namer.nameSession("Review the auth redirects");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Prefer concrete nouns from the person's request.");
    expect(prompts[0]).toContain("session title");
  });

  it("swallows failures and unknown models", async () => {
    const failing = fakeRuntime(() => { throw new Error("boom"); });
    const namer = new NamerService({ models: async () => failing, model: () => ({ provider: "stub", id: "stub-1" }) });
    expect(await namer.nameSession("x")).toBeNull();
    const missing = new NamerService({ models: async () => fakeRuntime(() => "ok", []), model: () => ({ provider: "stub", id: "nope" }) });
    expect(await missing.nameSession("x")).toBeNull();
  });

  it("qualifies a fast, valid cheap model on the session-title job and reports every candidate", async () => {
    const latency: Record<string, number> = { "fast-mini": 2, "slow-nano": 20, "bad-lite": 1, "gpt-pro": 30 };
    const runtime: NamerModelRuntime = {
      getModel: (provider, id) => ({ provider, id }),
      async completeSimple(model, context) {
        const m = model as { id: string };
        await new Promise((resolve) => setTimeout(resolve, latency[m.id] ?? 0));
        expect(context.messages[0]!.content).toContain(QUALIFY_SAMPLE);
        if (m.id === "bad-lite") return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: `Fix login form via ${m.id}` }] };
      },
    };
    const namer = new NamerService({
      models: async () => runtime,
      model: () => null,
      catalog: async () => ({
        models: [entry("p", "fast-mini", { input: 0.1, output: 0.1 }), entry("p", "slow-nano", { input: 0.1, output: 0.1 }), entry("p", "bad-lite", { input: 0.1, output: 0.1 }), entry("p", "gpt-pro", { input: 1, output: 1 })],
        configuredProviders: new Set(["p"]),
      }),
    });
    const state = await namer.qualify();
    expect(state.status).toBe("ready");
    expect(state.model).toEqual({ provider: "p", id: "fast-mini" });
    expect(state.candidates.map((c) => `${c.model.id}:${c.valid}`)).toEqual(["bad-lite:false", "fast-mini:true", "slow-nano:true", "gpt-pro:true"]);
    expect(state.candidates[1]?.costPerMillion).toBeCloseTo(0.2);
    expect(state.qualifiedAt).toBeDefined();
  });

  it("keeps a failed connected set retryable instead of declaring Namer unavailable", async () => {
    const namer = new NamerService({ models: async () => fakeRuntime(() => "x"), model: () => null, catalog: async () => ({ models: [entry("p", "gpt-pro")], configuredProviders: new Set(["p"]) }) });
    expect(await namer.qualify()).toMatchObject({ status: "unqualified", model: null, candidates: [{ valid: false }], reason: expect.stringMatching(/try again automatically/) });
  });

  it("keeps the current usable model when a requalification cannot improve it", async () => {
    const current = { provider: "p", id: "mini" };
    const namer = new NamerService({
      models: async () => fakeRuntime(() => { throw new Error("provider offline"); }, [current]),
      model: () => current,
      catalog: async () => ({ models: [entry("p", "mini", { input: 0.1, output: 0.1 })], configuredProviders: new Set(["p"]) }),
    });
    expect(await namer.qualify()).toMatchObject({ status: "ready", model: current, reason: expect.stringMatching(/kept/) });
  });
});
