import { describe, expect, it } from "vitest";

import {
  defaultModelChanges,
  modelOption,
  providerFilterForModel,
} from "../../src/components/assistant-ui/elements/model-selector.js";

describe("the new-session model picker", () => {
  it("writes provider and model together before a session exists", () => {
    expect(defaultModelChanges({ provider: "workers-ai", id: "deepseek-ai/deepseek-r1" })).toEqual([
      { path: "defaultProvider", op: "set", value: "workers-ai" },
      { path: "defaultModel", op: "set", value: "deepseek-ai/deepseek-r1" },
    ]);
  });

  it("labels the provider being paid, not the model developer", () => {
    const option = modelOption({ provider: "cloudflare-workers-ai", id: "deepseek-ai/deepseek-r1", name: "DeepSeek R1" });
    expect(option.provider).toBe("cloudflare-workers-ai");
    expect(option.providerTag).toBe("Workers AI");
  });

  it("opens in the provider that owns the selected session model", () => {
    const selected = modelOption({ provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" });
    expect(providerFilterForModel(selected)).toBe("openai-codex");
    expect(providerFilterForModel(undefined)).toBe("all");
  });
});
