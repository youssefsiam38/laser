/**
 * The `piorbit pi` split rule decides whether a flag reaches Pi or is eaten by
 * piorbit. Getting it wrong is invisible until someone's `--help` goes to the
 * wrong program, so it is pinned here.
 */
import { describe, expect, it } from "vitest";
import { splitPiArgs } from "../src/commands/pi.js";

describe("splitPiArgs", () => {
  it("gives Pi everything when the first token is Pi's", () => {
    expect(splitPiArgs(["--help"])).toEqual({ global: false, overrides: {}, rest: ["--help"] });
    expect(splitPiArgs(["--version"]).rest).toEqual(["--version"]);
    expect(splitPiArgs(["update", "--extensions"]).rest).toEqual(["update", "--extensions"]);
  });

  it("consumes piorbit's flags only while they lead", () => {
    const split = splitPiArgs(["--global-pi", "--agent-dir", "/tmp/x", "models", "--json"]);
    expect(split.global).toBe(true);
    expect(split.overrides).toEqual({ "agent-dir": "/tmp/x" });
    expect(split.rest).toEqual(["models", "--json"]);
  });

  it("stops eating after Pi's first argument, so a later --agent-dir is Pi's", () => {
    expect(splitPiArgs(["models", "--agent-dir", "/tmp/x"]).rest).toEqual(["models", "--agent-dir", "/tmp/x"]);
    expect(splitPiArgs(["models", "--agent-dir", "/tmp/x"]).overrides).toEqual({});
  });

  it("lets `--` force a piorbit flag through to Pi", () => {
    expect(splitPiArgs(["--", "--global-pi"]).rest).toEqual(["--global-pi"]);
    expect(splitPiArgs(["--", "--global-pi"]).global).toBe(false);
  });

  it("accepts --flag=value", () => {
    expect(splitPiArgs(["--agent-dir=/tmp/x", "-p", "hi"])).toEqual({
      global: false,
      overrides: { "agent-dir": "/tmp/x" },
      rest: ["-p", "hi"],
    });
  });

  it("refuses a value-less directory flag rather than passing a stray token to Pi", () => {
    expect(() => splitPiArgs(["--agent-dir"])).toThrowError(/expects a directory/);
  });

  it("passes an empty argument list through, so `piorbit pi` starts the TUI", () => {
    expect(splitPiArgs([]).rest).toEqual([]);
  });
});
