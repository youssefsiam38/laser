import { describe, expect, it } from "vitest";

import { LINUX_CHROME, LINUX_WINDOW_FRAME } from "../src/window-frame.js";

describe("Linux window frame", () => {
  it("keeps input geometry in the native frame path", () => {
    expect(LINUX_WINDOW_FRAME).toEqual({ frame: true });
    expect(LINUX_CHROME).toEqual({ controls: "system", height: 0, insetLeft: 0, insetRight: 0 });
  });
});
