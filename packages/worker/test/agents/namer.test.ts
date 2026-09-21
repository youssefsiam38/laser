/**
 * Naming: title post-processing, and the one-shot walk of the naming profile
 * against a fake runtime (`docs/model-profiles.md`, "Runtime").
 *
 * There is no benchmark and no candidate ranking any more: the person chose an
 * ordered list of models, and that list is the answer.
 */
import { SESSION_NAME_MAX, type ModelProfile } from "@lasercode/protocol";
import { describe, expect, it, vi } from "vitest";
import { NamerService, cleanSessionName, normalizeSessionName, type NamerModelRuntime } from "../../src/agents/namer.js";

function profileOf(...models: Array<{ provider: string; id: string }>): ModelProfile {
  return { id: "mp_testnaming000000000000", name: "Fast", models, origin: "seeded", updatedAt: "2026-01-01T00:00:00.000Z" };
}
const FAST = profileOf({ provider: "stub", id: "stub-1" });

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
  it("names a session from its first prompt, and does nothing without a profile", async () => {
    const runtime = fakeRuntime(() => '"Fix login form submit."');
    let profile: ModelProfile | null = null;
    const namer = new NamerService({ models: async () => runtime, profile: () => profile });
    expect(namer.enabled()).toBe(false);
    expect(await namer.nameSession("please fix the login form")).toBeNull();
    profile = FAST;
    expect(namer.enabled()).toBe(true);
    expect(await namer.nameSession("please fix the login form")).toBe("Fix login form submit");
    expect(runtime.calls).toBe(1);
  });

  it("walks the profile once, in order, and stops at the first usable title", async () => {
    // The first model is not in the catalogue and the second answers with
    // nothing usable; the third names the session. One request each, no
    // retries, no second pass.
    const asked: string[] = [];
    const runtime: NamerModelRuntime & { calls: number } = {
      calls: 0,
      getModel: (provider, id) => (id === "gone" ? undefined : { provider, id }),
      async completeSimple(model, _context) {
        runtime.calls += 1;
        const id = (model as { id: string }).id;
        asked.push(id);
        return { content: [{ type: "text", text: id === "empty" ? "" : "Fix the login form" }] };
      },
    };
    const namer = new NamerService({
      models: async () => runtime,
      profile: () => profileOf({ provider: "p", id: "gone" }, { provider: "p", id: "empty" }, { provider: "p", id: "works" }),
    });
    expect(await namer.nameSession("please fix the login form")).toBe("Fix the login form");
    expect(asked).toEqual(["empty", "works"]);
  });

  it("gives back no name at all when the whole profile is spent", async () => {
    const namer = new NamerService({
      models: async () => fakeRuntime(() => { throw new Error("offline"); }, [{ provider: "p", id: "one" }, { provider: "p", id: "two" }]),
      profile: () => profileOf({ provider: "p", id: "one" }, { provider: "p", id: "two" }),
    });
    expect(await namer.nameSession("x")).toBeNull();
  });

  it("layers the editable Namer instructions into session-title requests", async () => {
    const prompts: string[] = [];
    const runtime = fakeRuntime((context) => {
      prompts.push(context.systemPrompt ?? "");
      return "Review auth redirects";
    });
    const namer = new NamerService({
      models: async () => runtime,
      profile: () => FAST,
      instructions: () => "Prefer concrete nouns from the person's request.",
    });
    await namer.nameSession("Review the auth redirects");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Prefer concrete nouns from the person's request.");
    expect(prompts[0]).toContain("session title");
  });

  it("uses the shipped prompt for a turn when a stored override names removed fields", async () => {
    const prompts: string[] = [];
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = fakeRuntime((context) => {
      prompts.push(context.systemPrompt ?? "");
      return "Review auth redirects";
    });
    const namer = new NamerService({
      models: async () => runtime,
      profile: () => FAST,
      instructions: () => "Name {{toolName}} for {{namingTask}}.",
    });
    expect(await namer.nameSession("Review the auth redirects")).toBe("Review auth redirects");
    expect(prompts[0]).toContain("You name sessions from what the person wants done.");
    expect(prompts[0]).not.toContain("toolName");
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("using the shipped prompt for this turn"), expect.stringContaining("toolName"));
    diagnostic.mockRestore();
  });

  it("swallows failures and unknown models", async () => {
    const failing = fakeRuntime(() => { throw new Error("boom"); });
    const namer = new NamerService({ models: async () => failing, profile: () => FAST });
    expect(await namer.nameSession("x")).toBeNull();
    const missing = new NamerService({ models: async () => fakeRuntime(() => "ok", []), profile: () => profileOf({ provider: "stub", id: "nope" }) });
    expect(await missing.nameSession("x")).toBeNull();
  });

});
