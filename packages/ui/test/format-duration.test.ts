import { describe, expect, it } from "vitest";
import { duration } from "../src/format.js";

describe("duration", () => {
  it("never shows sixty seconds", () => {
    expect(duration(59_600)).toBe("1m 0s");
    expect(duration(119_600)).toBe("2m 0s");
    expect(duration(59_400)).toBe("59s");
    expect(duration(61_000)).toBe("1m 1s");
    expect(duration(9_960)).toBe("10.0s");
    expect(duration(10_400)).toBe("10s");
    expect(duration(999)).toBe("999ms");
  });
});
