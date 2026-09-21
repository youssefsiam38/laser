/**
 * Naming: title post-processing, and the one-shot walk of the naming profile
 * against a fake runtime (`docs/model-profiles.md`, "Runtime").
 *
 * There is no benchmark and no candidate ranking any more: the person chose an
 * ordered list of models, and that list is the answer.
 */
import { SESSION_NAME_MAX, type ModelProfile } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { canNameSessions, cleanSessionName, nameSession, normalizeSessionName, type CompletionRuntime } from "../../src/agents/session-naming.js";

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

function fakeRuntime(answer: (context: { systemPrompt?: string; messages: Array<{ content: string }> }) => string | Promise<string>, models = [{ provider: "stub", id: "stub-1" }]): CompletionRuntime & { calls: number } {
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

describe("nameSession", () => {
  it("names a session from its first prompt, and does nothing without a profile", async () => {
    const runtime = fakeRuntime(() => '"Fix login form submit."');
    const models = async () => runtime;
    expect(canNameSessions(null)).toBe(false);
    expect(await nameSession("please fix the login form", { models, profile: null })).toBeNull();
    expect(runtime.calls).toBe(0);
    expect(canNameSessions(FAST)).toBe(true);
    expect(await nameSession("please fix the login form", { models, profile: FAST })).toBe("Fix login form submit");
    expect(runtime.calls).toBe(1);
  });

  it("asks for a title with no identity and no editable prompt behind it", async () => {
    const prompts: string[] = [];
    const runtime = fakeRuntime((context) => {
      prompts.push(context.systemPrompt ?? "");
      return "Review auth redirects";
    });
    expect(await nameSession("Review the auth redirects", { models: async () => runtime, profile: FAST })).toBe("Review auth redirects");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("session title");
    // Nothing gives this request a persona or a product name (D-347).
    expect(prompts[0]).not.toMatch(/You are/i);
    expect(prompts[0]).not.toMatch(/laser/i);
  });

  it("walks the profile once, in order, and stops at the first usable title", async () => {
    // The first model is not in the catalogue and the second answers with
    // nothing usable; the third names the session. One request each, no
    // retries, no second pass.
    const asked: string[] = [];
    const runtime: CompletionRuntime & { calls: number } = {
      calls: 0,
      getModel: (provider, id) => (id === "gone" ? undefined : { provider, id }),
      async completeSimple(model, _context) {
        runtime.calls += 1;
        const id = (model as { id: string }).id;
        asked.push(id);
        return { content: [{ type: "text", text: id === "empty" ? "" : "Fix the login form" }] };
      },
    };
    const name = await nameSession("please fix the login form", {
      models: async () => runtime,
      profile: profileOf({ provider: "p", id: "gone" }, { provider: "p", id: "empty" }, { provider: "p", id: "works" }),
    });
    expect(name).toBe("Fix the login form");
    expect(asked).toEqual(["empty", "works"]);
  });

  it("gives back no name at all when the whole profile is spent", async () => {
    const runtime = fakeRuntime(() => { throw new Error("offline"); }, [{ provider: "p", id: "one" }, { provider: "p", id: "two" }]);
    expect(await nameSession("x", { models: async () => runtime, profile: profileOf({ provider: "p", id: "one" }, { provider: "p", id: "two" }) })).toBeNull();
  });

  it("gives up quietly, never throwing, on failures and unknown models", async () => {
    const failing = fakeRuntime(() => { throw new Error("boom"); });
    expect(await nameSession("x", { models: async () => failing, profile: FAST })).toBeNull();
    expect(await nameSession("x", { models: async () => fakeRuntime(() => "ok", []), profile: profileOf({ provider: "stub", id: "nope" }) })).toBeNull();
    expect(await nameSession("x", { models: async () => { throw new Error("no runtime"); }, profile: FAST })).toBeNull();
    // Nothing to name.
    expect(await nameSession("   ", { models: async () => failing, profile: FAST })).toBeNull();
  });

  it("stops a model that will not answer inside the ceiling", async () => {
    const runtime = fakeRuntime(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "Too late to matter here";
    });
    expect(await nameSession("x", { models: async () => runtime, profile: FAST, timeoutMs: 1 })).toBeNull();
  });
});
