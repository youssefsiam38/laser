import { describe, expect, it } from "vitest";

import { messageTokenRate } from "../../src/components/assistant-ui/elements/message-timing.aui.js";

describe("message token rate", () => {
  it("derives generated tokens per second from the displayed output and duration", () => {
    expect(messageTokenRate(240, 2_000, undefined)).toBe(120);
  });

  it("prefers the runtime's measured streaming rate", () => {
    expect(messageTokenRate(240, 2_000, 96.4)).toBe(96.4);
  });

  it("does not invent a rate without a positive duration", () => {
    expect(messageTokenRate(240, undefined, undefined)).toBeUndefined();
    expect(messageTokenRate(240, 0, undefined)).toBeUndefined();
  });
});
