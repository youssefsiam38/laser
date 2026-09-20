import { describe, expect, it } from "vitest";
import {
  isProcessAlive,
  parseLinuxProcessIdentity,
  parseUnixPsIdentity,
  parseWindowsCimCreationIdentity,
  processIdentity,
} from "../src/process-identity.js";

describe("process identity parsers", () => {
  it("parses Linux /proc/<pid>/stat from the last parenthesis", () => {
    const fields = Array.from({ length: 20 }, (_, index) => (index === 19 ? "4242" : String(index)));
    const stat = `9 (comm with ) parens) ${fields.join(" ")} trailing`;
    expect(parseLinuxProcessIdentity("  boot-id-one \n", stat)).toBe("linux:boot-id-one:4242");
    expect(parseLinuxProcessIdentity("", stat)).toBeUndefined();
    expect(parseLinuxProcessIdentity("boot", "no-close-paren")).toBeUndefined();
  });

  it("parses Unix ps lstart output", () => {
    expect(parseUnixPsIdentity("  Mon Jan  1 00:00:01 2024 \n")).toBe("ps:Mon Jan  1 00:00:01 2024");
    expect(parseUnixPsIdentity("   \n")).toBeUndefined();
  });

  it("parses a stable Windows CIM creation datetime and refuses localized forms", () => {
    expect(parseWindowsCimCreationIdentity("20240115123045.123456-480\n")).toBe("win:20240115123045.123456-480");
    expect(parseWindowsCimCreationIdentity("CreationDate\n20240115123045.123456+000\n")).toBe("win:20240115123045.123456+000");
    expect(parseWindowsCimCreationIdentity("2024-01-15T12:30:45.123Z\n")).toBe("win:2024-01-15T12:30:45.123Z");
    expect(parseWindowsCimCreationIdentity("1/15/2024 12:30:45 PM\n")).toBeUndefined();
    expect(parseWindowsCimCreationIdentity("Monday, January 15, 2024 12:30:45 PM\n")).toBeUndefined();
    expect(parseWindowsCimCreationIdentity("\n")).toBeUndefined();
  });
});

describe("process identity of this process", () => {
  it("round-trips the current pid to the same string twice", () => {
    const first = processIdentity(process.pid);
    const second = processIdentity(process.pid);
    expect(first).toBe(second);
    if (process.platform === "linux") expect(first).toMatch(/^linux:[0-9a-f-]+:\d+$/);
  });

  it("does not identify a dead pid", () => {
    expect(processIdentity(0)).toBeUndefined();
    expect(processIdentity(-1)).toBeUndefined();
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
