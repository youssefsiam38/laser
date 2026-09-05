/**
 * The parser is the one piece of this package where a quiet mistake changes
 * what a command does rather than how it looks, so it gets a test.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { describe, expect, it } from "vitest";
import { bool, list, num, parseArgs, str, type FlagSpecs } from "../src/args.js";
import { scanLeadingGlobals } from "../src/cli.js";

const specs: FlagSpecs = {
  json: { type: "boolean", description: "json" },
  open: { type: "boolean", default: true, description: "open" },
  follow: { type: "boolean", short: "f", description: "follow" },
  all: { type: "boolean", short: "a", description: "all" },
  port: { type: "number", short: "p", description: "port" },
  session: { type: "string", short: "s", description: "session" },
  include: { type: "string", repeat: true, description: "include" },
  color: { type: "string", choices: ["auto", "never"], description: "color" },
};

describe("parseArgs", () => {
  it("reads booleans, values and positionals", () => {
    const parsed = parseArgs(["--json", "-p", "41441", "--session", "abc", "hello", "world"], specs);
    expect(bool(parsed, "json")).toBe(true);
    expect(num(parsed, "port")).toBe(41441);
    expect(str(parsed, "session")).toBe("abc");
    expect(parsed.positionals).toEqual(["hello", "world"]);
  });

  it("accepts --flag=value and -f=value", () => {
    const parsed = parseArgs(["--session=abc", "--port=99"], specs);
    expect(str(parsed, "session")).toBe("abc");
    expect(num(parsed, "port")).toBe(99);
  });

  it("applies defaults and negates any boolean with --no-", () => {
    expect(bool(parseArgs([], specs), "open")).toBe(true);
    expect(bool(parseArgs(["--no-open"], specs), "open")).toBe(false);
  });

  it("groups short booleans and lets a value-taking short end the group", () => {
    const parsed = parseArgs(["-af", "-p", "1"], specs);
    expect(bool(parsed, "all")).toBe(true);
    expect(bool(parsed, "follow")).toBe(true);
    expect(num(parsed, "port")).toBe(1);
  });

  it("refuses a value-taking short inside a group, because the value would be lost", () => {
    expect(() => parseArgs(["-pa", "1"], specs)).toThrowError(/cannot sit inside the group/);
  });

  it("collects repeated flags", () => {
    expect(list(parseArgs(["--include", "a", "--include", "b"], specs), "include")).toEqual(["a", "b"]);
  });

  it("stops at `--` and keeps the rest verbatim", () => {
    const parsed = parseArgs(["--json", "--", "--json", "-p"], specs);
    expect(bool(parsed, "json")).toBe(true);
    expect(parsed.rest).toEqual(["--json", "-p"]);
    expect(parsed.hasRest).toBe(true);
  });

  it("treats a bare `-` as a positional, not a flag", () => {
    expect(parseArgs(["-"], specs).positionals).toEqual(["-"]);
  });

  it("rejects a missing value, an unknown flag, and a bad choice — each with a fix", () => {
    expect(() => parseArgs(["--session"], specs)).toThrowError(/expects/);
    expect(() => parseArgs(["--sessions"], specs)).toThrowError(/unknown option --sessions/);
    expect(() => parseArgs(["--color", "purple"], specs)).toThrowError(/does not accept/);
    expect(() => parseArgs(["--port", "nope"], specs)).toThrowError(/expects a number/);
  });

  it("does not let a switch take a value by accident", () => {
    expect(() => parseArgs(["--json=maybe"], specs)).toThrowError(/is a switch/);
    expect(bool(parseArgs(["--json=false"], specs), "json")).toBe(false);
  });
});

describe("scanLeadingGlobals", () => {
  it("consumes global flags that lead, and stops at the command name", () => {
    const { leading, index } = scanLeadingGlobals(["--agent-dir", "/tmp/x", "--json", "status"]);
    expect(leading).toEqual(["--agent-dir", "/tmp/x", "--json"]);
    expect(index).toBe(3);
  });

  it(`stops at a flag that is not global, so \`${PRODUCT_NAME} --no-open\` still means \`up\``, () => {
    const { leading, index } = scanLeadingGlobals(["--no-open"]);
    expect(leading).toEqual([]);
    expect(index).toBe(0);
  });

  it("handles --flag=value and short forms without eating the next token", () => {
    const { leading, index } = scanLeadingGlobals(["--agent-dir=/tmp/x", "-p", "41441", "sessions"]);
    expect(leading).toEqual(["--agent-dir=/tmp/x", "-p", "41441"]);
    expect(index).toBe(3);
  });
});
