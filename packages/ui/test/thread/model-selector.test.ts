import { describe, expect, it } from "vitest";

import {
  defaultProfileChanges,
  modelOption,
  providerFilterForModel,
} from "../../src/components/assistant-ui/elements/model-selector.js";

describe("the new-session model picker", () => {
  it("points new conversations at a profile, never at a raw model", () => {
    expect(defaultProfileChanges("mp_balanced0000000000")).toEqual([
      { path: "defaultProfileId", op: "set", value: "mp_balanced0000000000" },
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
