import { describe, expect, it } from "vitest";
import { MIB_BYTES, configuredOldSpaceBytes, nodeLaunchEnvironment } from "../src/heap-ceiling.js";

describe("explicit Node heap configuration", () => {
  it.each([
    { argv: [], expected: undefined },
    { argv: ["--max-old-space-size=bad"], expected: undefined },
    { argv: ["--max-old-space-size=256", "--max-old-space-size", "448"], expected: 448 * MIB_BYTES },
    { argv: ["--max-old-space-size=448", "--max-old-space-size=0"], expected: undefined },
    { argv: ["--max-old-space-size", "9007199254740992"], expected: undefined },
  ])("parses only the last valid positive explicit spelling: $argv", ({ argv, expected }) => {
    expect(configuredOldSpaceBytes(argv)).toBe(expected);
  });

  it("removes every NODE_OPTIONS spelling and optional platform controls", () => {
    expect(nodeLaunchEnvironment({
      HOME: "/scratch",
      NODE_OPTIONS: "--max-old-space-size=1",
      Node_Options: "--trace-warnings",
      ELECTRON_RUN_AS_NODE: "1",
    }, { dropPrefixes: ["ELECTRON_"] })).toEqual({ HOME: "/scratch" });
  });
});
