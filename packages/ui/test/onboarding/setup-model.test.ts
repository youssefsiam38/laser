/**
 * Where the first-run flow resumes (M10-T6). The rule has three inputs — what
 * the host says is done, where the person left, and whether they have seen the
 * flow at all — and a wrong answer either re-asks for a credential that exists
 * or skips past one that is missing. Neither shows up as an error anywhere.
 */
import { describe, expect, it } from "vitest";

import { firstIncomplete, resumeStep, sortProviders } from "../../src/components/onboarding/setup-model.js";

const facts = (providersConfigured: number | undefined, hasDefaultModel: boolean | undefined, projects: number) => ({
  providersConfigured,
  hasDefaultModel,
  projects,
});

describe("resumeStep", () => {
  it("starts at the welcome the first time, whatever is already configured", () => {
    expect(resumeStep(facts(0, false, 0), undefined)).toBe("welcome");
    expect(resumeStep(facts(2, true, 3), undefined)).toBe("welcome");
  });
  it("goes from the welcome to the first thing that is missing", () => {
    expect(resumeStep(facts(0, false, 0), "welcome")).toBe("provider");
    expect(resumeStep(facts(1, false, 0), "welcome")).toBe("model");
    expect(resumeStep(facts(1, true, 0), "welcome")).toBe("project");
    expect(resumeStep(facts(1, true, 1), "welcome")).toBe("ready");
  });
  it("returns to the remembered step, unless something before it is no longer done", () => {
    expect(resumeStep(facts(1, true, 0), "project")).toBe("project");
    expect(resumeStep(facts(1, false, 0), "project")).toBe("model");
    expect(resumeStep(facts(0, false, 0), "ready")).toBe("provider");
    // Left on a step that has since been completed elsewhere: still shown, it says so itself.
    expect(resumeStep(facts(1, true, 1), "provider")).toBe("provider");
  });
  it("honours the remembered step while the host has not answered", () => {
    expect(resumeStep(facts(undefined, undefined, 0), "model")).toBe("model");
    expect(firstIncomplete(facts(undefined, true, 0))).toBeUndefined();
  });
});

describe("sortProviders", () => {
  it("puts signed-in providers first, familiar ones next, then the alphabet", () => {
    const sorted = sortProviders([
      { id: "zzz", name: "Zed", configured: false },
      { id: "openai", name: "OpenAI", configured: false },
      { id: "anthropic", name: "Anthropic", configured: false },
      { id: "acme", name: "Acme", configured: true },
      { id: "bbb", name: "Bee", configured: false },
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["acme", "anthropic", "openai", "bbb", "zzz"]);
  });
});
