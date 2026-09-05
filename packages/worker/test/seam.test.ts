/**
 * Seam test (M0-T5): the protocol package must not import Pi, and both drivers
 * must satisfy SessionDriver. Runs without Pi installed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ChordDriver } from "../src/drivers/chord.js";
import { DriverUnavailableError, type SessionDriver } from "../src/driver.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Matches real import/require/export-from statements, not comments. */
const PI_IMPORT = /(?:from|import|require)\s*\(?\s*["'](?:@earendil-works\/|pi-subagents)/;

describe("driver seam", () => {
  it("protocol package imports nothing from Pi", () => {
    const protocolSrc = join(import.meta.dirname, "../../protocol/src");
    for (const file of walk(protocolSrc)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(PI_IMPORT);
    }
  });

  it("driver.ts imports no Pi types", () => {
    const text = readFileSync(join(import.meta.dirname, "../src/driver.ts"), "utf8");
    expect(text).not.toMatch(PI_IMPORT);
  });

  it("ChordDriver satisfies SessionDriver and fails closed", async () => {
    const driver: SessionDriver = new ChordDriver();
    expect(driver.kind).toBe("chord");
    await expect(driver.open({ cwd: "/tmp" })).rejects.toBeInstanceOf(DriverUnavailableError);
  });
});
