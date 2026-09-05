/**
 * The two strings `src/preload.cts` may not import (MX-T7).
 *
 * A sandboxed preload's `require` resolves only `electron` and a few Node
 * builtins, so it cannot read `src/api.ts` and has to repeat the bridge name
 * and the argv prefix as literals. That is the one duplication the identity
 * rules allow, and this is what keeps the two copies equal: if they drift, the
 * renderer looks for a bridge the preload never exposed and every desktop-only
 * feature silently disappears with nothing on screen to explain it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_ARGUMENT_PREFIX, DESKTOP_BRIDGE } from "../src/api.js";

const preload = readFileSync(fileURLToPath(new URL("../src/preload.cts", import.meta.url)), "utf8");

describe("the preload's own copy of the bridge contract", () => {
  it("exposes the bridge api.ts names", () => {
    expect(preload).toContain(`const BRIDGE = ${JSON.stringify(DESKTOP_BRIDGE)};`);
    expect(preload).toContain("contextBridge.exposeInMainWorld(BRIDGE, api);");
  });

  it("reads the argv switches api.ts writes", () => {
    expect(preload).toContain(`const ARGUMENT_PREFIX = ${JSON.stringify(DESKTOP_ARGUMENT_PREFIX)};`);
  });

  it("imports nothing but electron, because a sandboxed preload cannot", () => {
    const imports = [...preload.matchAll(/^import .*?from ["']([^"']+)["'];?$/gm)].map((match) => match[1]);
    const requires = [...preload.matchAll(/= require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    expect([...imports, ...requires].filter((specifier) => specifier !== "electron" && !specifier.startsWith("./"))).toEqual([]);
  });
});
